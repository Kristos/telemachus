/**
 * Phase 65 (HYG-01): Extracted from runner.ts — per-turn execution body.
 *
 * Owns the sequence that runs INSIDE the enqueue closure (and inside the
 * wrapTurnExecution try/catch):
 *   1. Tool-result stripping trigger (Phase 57 STRIP-03..05)
 *   2. Compression-aware token-cap enforcement (Phase 61 COST-07 + COST-06)
 *   3. Per-user daily budget gate (Phase 56 BUDGET-01)
 *   4. SubagentParent assembly + multimodal message construction
 *   5. Pre-spawn sandbox probe (Phase 62 SAND-02)
 *   6. runSubagent with onTextChunk + onTurnComplete hooks
 *   7. Assistant message record + session persistence + writer.finalize
 *
 * All Discord-runner dependencies (conversations, provider, config, etc.)
 * come in via DiscordRunnerDeps. The enclosing runner.ts supplies the
 * per-turn closure state (turnId, agg, routerSession, writer, etc.) via
 * TurnExecutionContext. A setContextSize() callback lets the body mutate
 * the closure-scoped contextSizeTokens that the error-boundary reads at
 * finally-time.
 */
import type { DiscordRunnerDeps } from './runner.js'
import type { DiscordMessage, ImageBlock } from './message-intake.js'
import type { ReplyWriter } from './reply-writer.js'
import type { SubagentParent } from '../agent/subagent.js'
import type { UsageRecord } from './usage-store.js'
import { runSubagent } from '../agent/subagent.js'
import { resolveContextCap } from './conversation.js'
import { resolveModelPricing } from '../usage/pricing.js'
import { probeSandbox } from '../security/sandbox-probe.js'
import { ensureSession, persistTurnDelta } from './session-bridge.js'
import { appendAuditEntry } from '../security/audit.js'
import { appendUsage } from './usage-store.js'
import { log } from '../log/logger.js'

export interface TurnAgg {
  inputTokens: number
  outputTokens: number
  costUsd: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface TurnRouterSession {
  routedTo?: import('../config/types.js').IntentClass
  routedModel?: string
  classifierTokens?: number
}

export interface TurnExecutionContext {
  deps: DiscordRunnerDeps
  msg: DiscordMessage
  writer: ReplyWriter
  targetChannelId: string
  turnId: string
  routerSession: TurnRouterSession
  agg: TurnAgg
  enrichedContent: string
  imageBlocks: ImageBlock[]
  /** Writeback so runner.ts can hold the closure-scoped contextSizeTokens. */
  setContextSize: (tokens: number) => void
}

/**
 * Run the body of a Discord turn. Called inside wrapTurnExecution so
 * throws bubble up to the error-boundary's catch. The returned promise
 * resolves when the turn is complete (reply posted, session persisted,
 * or early-return because of budget/sandbox gate).
 */
export async function runTurnBody(ctx: TurnExecutionContext): Promise<void> {
  const {
    deps,
    msg,
    writer,
    targetChannelId,
    turnId,
    routerSession,
    agg,
    enrichedContent,
    imageBlocks,
    setContextSize,
  } = ctx

  // Phase 57 (STRIP-03..05): tool-result stripping trigger.
  // Discord-only by code path — never called from CLI/agent-runner entry points.
  // Fires BEFORE addUserMessage so the new user message is never itself stripped.
  const compressionThreshold = deps.config.discord?.compressionThreshold
  if (compressionThreshold && compressionThreshold > 0) {
    const tokensBefore = deps.conversations.getTokenEstimate(targetChannelId)
    if (tokensBefore > compressionThreshold) {
      const keepTail = deps.config.discord?.compressionKeepTailTurns ?? 4
      const stripResult = deps.conversations.stripToolResults(targetChannelId, keepTail)
      void appendAuditEntry({
        ts: new Date().toISOString(),
        kind: 'compression_fired',
        sessionId: `discord-${targetChannelId}`,
        platform: process.platform,
        source: 'discord',
        discordUserId: msg.authorId,
        discordChannelId: targetChannelId,
        turnId,
        tokensBefore: stripResult.tokensBefore,
        tokensAfter: stripResult.tokensAfter,
        turnsStripped: stripResult.turnsStripped,
        strategy: 'tool_strip',
      })
    }
  }

  // Record user message; fetch history (includes the new message)
  deps.conversations.addUserMessage(targetChannelId, enrichedContent)
  const history = deps.conversations.getHistory(targetChannelId)

  // COST-07 (Phase 61): enforce token-bounded context cap BEFORE runSubagent.
  // COST-08 + COST-06: contextSizeTokens reflects POST-truncation count.
  const activeProfile = deps.config.activeProfile
  const profileOverride = activeProfile
    ? deps.config.profiles?.[activeProfile]?.contextTokenCap
    : undefined
  const cap = resolveContextCap(deps.model, profileOverride)
  const capResult = await deps.conversations.enforceTokenCap(
    targetChannelId,
    deps.provider,
    cap,
  )
  setContextSize(capResult.after)

  // Ensure JSONL session exists for this channel
  const sessionId = await ensureSession(targetChannelId, deps.sessionMapping, deps.model)

  // BUDGET-01: Per-user daily token budget gate.
  if (deps.tokenBudget) {
    const historyChars = history.reduce(
      (n, m) => n + JSON.stringify(m.content).length,
      0,
    )
    const estimate = Math.ceil(historyChars / 4) + 4_000
    const verdict = deps.tokenBudget.checkBudget(msg.authorId, estimate)
    if (verdict === 'exceeded') {
      const { usedToday, dailyTokens, resetAt } = deps.tokenBudget.getState(msg.authorId)
      const dmText =
        `You've used ${usedToday}/${dailyTokens} tokens today. ` +
        `Budget resets at ${new Date(resetAt).toISOString()}.`
      if (deps.sendDm) {
        await deps.sendDm(msg.authorId, dmText).catch(() => {})
      } else {
        await msg.reply(dmText).catch(() => {})
      }
      return
    }
  }

  // Build SubagentParent — mirrors agent-runner/build-parent.ts pattern
  // but with Discord-specific ToolContext attribution fields (SEC-13).
  const toolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: deps.config.toolTimeoutMs,
    askUser: async () => '',
    checkPermission: async () => 'allow' as const,
    sessionId: `discord-${targetChannelId}`,
    mode: 'agent' as const,
    originalCwd: process.cwd(),
    source: 'discord' as const,
    discordUserId: msg.authorId,
    discordChannelId: targetChannelId,
  }
  const parent: SubagentParent = {
    provider: deps.provider,
    registry: deps.registry,
    apiSchemas: deps.registry.toAPISchema(),
    toolContext: {
      ...toolContext,
      subagentParent: {
        provider: deps.provider,
        registry: deps.registry,
        apiSchemas: deps.registry.toAPISchema(),
        toolContext,
        temperature: deps.config.temperature,
        windowSize: deps.config.windowSize,
        maxIterations: 20,
        // ROUTE-06: task-tool subagents on Discord must inherit turnId so
        // RouterProvider can reuse the parent's per-turn route decision.
        // routerSession flows through too so classifier-token accounting
        // stays accurate across subagent calls.
        turnId,
        routerSession,
      },
    },
    temperature: deps.config.temperature,
    windowSize: deps.config.windowSize,
    maxIterations: 20,
    turnId,
    routerSession,
  }

  const priorHistory = history.slice(0, -1)

  // Multimodal message assembly when images are attached.
  let agentPrompt = enrichedContent
  let agentInitialMessages = priorHistory.length > 0 ? priorHistory : undefined

  if (imageBlocks.length > 0) {
    const multimodalMessage: import('../providers/types.js').Message = {
      role: 'user',
      content: [
        { type: 'text' as const, text: enrichedContent },
        ...imageBlocks,
      ],
    }
    agentInitialMessages = [...(agentInitialMessages ?? []), multimodalMessage]
    agentPrompt = 'See the attached image(s) above along with my message.'
  }

  // Phase 62 (SAND-02): defensive pre-spawn probe.
  const sandProbe = probeSandbox({ sessionId: toolContext.sessionId })
  if (!sandProbe.pass) {
    const errMsg = `[sandbox_probe] ${sandProbe.reason ?? 'unknown'} — agent aborted. home='${sandProbe.home}', cwd='${sandProbe.cwd}'. See SAND-02 / BACKLOG 999.15.`
    log(
      'error',
      {
        sessionId: toolContext.sessionId,
        home: sandProbe.home,
        cwd: sandProbe.cwd,
        reason: sandProbe.reason,
      },
      'sandbox_probe failed before runSubagent',
    )
    try {
      await msg.reply(errMsg.slice(0, 1900))
    } catch {
      // Channel reply is best-effort — never crash the Discord handler
    }
    return
  }

  const result = await runSubagent(parent, agentPrompt, {
    initialMessages: agentInitialMessages,
    // Phase 64 (PERS-01): per-channel system prompt builder.
    systemPrompt: deps.systemPrompt?.(targetChannelId),
    // DISC-05: accumulate streamed tokens into the writer's buffer.
    onTextChunk: (chunk: string) => {
      writer.appendChunk(chunk)
    },
    // TOKEN-01: capture per-turn token usage to usage store and audit log.
    onTurnComplete: (usage) => {
      // BUDGET-01: record actual usage so the budget reflects consumed tokens
      deps.tokenBudget?.recordUsage(msg.authorId, usage.inputTokens + usage.outputTokens)
      // Phase 57 (MEAS-02, MEAS-03): aggregate per-iteration usage.
      // Phase 59.1 (FIX-ROUTER-03): use routed model when populated.
      const routedModel = parent.routerSession?.routedModel ?? deps.model
      const pricing = resolveModelPricing(routedModel, deps.config.discord)
      const iterationCost = pricing
        ? (usage.inputTokens / 1_000_000) * pricing.inputPerMToken
          + (usage.outputTokens / 1_000_000) * pricing.outputPerMToken
        : 0
      agg.inputTokens += usage.inputTokens
      agg.outputTokens += usage.outputTokens
      agg.costUsd += iterationCost
      // Phase 64 (CACHE-03): aggregate Anthropic prompt-cache tokens.
      agg.cacheReadTokens += usage.cacheReadTokens
      agg.cacheCreationTokens += usage.cacheCreationTokens
      const record: UsageRecord = {
        ts: new Date().toISOString(),
        channelId: targetChannelId,
        userId: msg.authorId,
        model: routedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        turnId,
      }
      void appendUsage(record)
      void appendAuditEntry({
        ts: record.ts,
        kind: 'discord_turn',
        sessionId: `discord-${targetChannelId}`,
        platform: process.platform,
        source: 'discord',
        discordUserId: msg.authorId,
        discordChannelId: targetChannelId,
      })
    },
  })

  const responseText =
    result.text ||
    (result.error ? `Error: ${result.error.message}` : 'No response generated.')

  // Record assistant response for future turns
  deps.conversations.addAssistantMessage(targetChannelId, responseText)

  // Persist new messages to JSONL (delta = everything after prior history)
  const priorLen = priorHistory.length + 1
  await persistTurnDelta(sessionId, priorLen, result.messages)

  // Chunk and send final response via the writer (edits placeholder +
  // posts follow-ups when chunk count > 1).
  await writer.finalize(responseText)
}
