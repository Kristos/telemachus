/**
 * Phase 70 (TGAGENT-01..04): Per-turn execution body for Telegram agent loop.
 *
 * Near-copy of src/discord/turn-execution.ts with mechanical substitutions:
 *   - DiscordRunnerDeps → TelegramRunnerDeps
 *   - DiscordMessage + attachment params → NormalizedTelegramIntake (text-only, no attachments)
 *   - targetChannelId → targetChatId
 *   - discord_turn → telegram_turn / source: 'telegram'
 *   - Multimodal image block assembly removed (Phase 70 is text-only)
 *   - Sandbox probe error routed through writer.replySend (HTML mode) instead of msg.reply
 *
 * Owns the sequence that runs INSIDE the enqueue closure (and inside the
 * wrapTurnExecution try/catch):
 *   1. Tool-result stripping trigger (optional: only when config present)
 *   2. Compression-aware token-cap enforcement
 *   3. Per-user daily budget gate (optional: skipped when deps.tokenBudget is absent)
 *   4. SubagentParent assembly (text-only; no multimodal content)
 *   5. Pre-spawn sandbox probe (SAND-02)
 *   6. runSubagent with onTextChunk → writer.appendChunk + onTurnComplete hooks
 *   7. Assistant message record + session persistence + writer.finalize
 */
import type { TelegramRunnerDeps } from './runner.js'
import type { NormalizedTelegramIntake } from './message-intake.js'
import type { ReplyWriter } from './reply-writer.js'
import type { SubagentParent } from '../agent/subagent.js'
import type { UsageRecord } from './usage-store.js'
import { runSubagent } from '../agent/subagent.js'
import { resolveContextCap } from '../discord/conversation.js'
import { resolveModelPricing } from '../usage/pricing.js'
import { probeSandbox } from '../security/sandbox-probe.js'
import { ensureSession, persistTurnDelta } from './session-bridge.js'
import { appendAuditEntry } from '../security/audit.js'
import { appendUsage } from './usage-store.js'
import { escapeHtml } from './html-escape.js'
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
  deps: TelegramRunnerDeps
  msg: NormalizedTelegramIntake
  writer: ReplyWriter
  targetChatId: string
  turnId: string
  routerSession: TurnRouterSession
  agg: TurnAgg
  content: string
  /** Writeback so runner.ts can hold the closure-scoped contextSizeTokens. */
  setContextSize: (tokens: number) => void
}

/**
 * Run the body of a Telegram turn. Called inside wrapTurnExecution so
 * throws bubble up to the error-boundary's catch. The returned promise
 * resolves when the turn is complete (reply posted, session persisted,
 * or early-return because of sandbox gate).
 */
export async function runTurnBody(ctx: TurnExecutionContext): Promise<void> {
  const {
    deps,
    msg,
    writer,
    targetChatId,
    turnId,
    routerSession,
    agg,
    content,
    setContextSize,
  } = ctx

  // Tool-result stripping trigger — mirrors Discord logic but using telegram config.
  // TelegramConfig does not have compressionThreshold today; use a safe cast.
  const compressionThreshold = (deps.config.telegram as { compressionThreshold?: number } | undefined)?.compressionThreshold
  if (compressionThreshold && compressionThreshold > 0) {
    const tokensBefore = deps.conversations.getTokenEstimate(targetChatId)
    if (tokensBefore > compressionThreshold) {
      const keepTail = 4 // literal — TelegramConfig has no compressionKeepTailTurns yet
      const stripResult = deps.conversations.stripToolResults(targetChatId, keepTail)
      void appendAuditEntry({
        ts: new Date().toISOString(),
        kind: 'compression_fired',
        sessionId: `telegram-${targetChatId}`,
        platform: process.platform,
        source: 'telegram',
        telegramUserId: msg.authorId,
        telegramChatId: targetChatId,
        turnId,
        tokensBefore: stripResult.tokensBefore,
        tokensAfter: stripResult.tokensAfter,
        turnsStripped: stripResult.turnsStripped,
        strategy: 'tool_strip',
      })
    }
  }

  // Record user message; fetch history (includes the new message)
  deps.conversations.addUserMessage(targetChatId, content)
  const history = deps.conversations.getHistory(targetChatId)

  // Enforce token-bounded context cap BEFORE runSubagent.
  const activeProfile = deps.config.activeProfile
  const profileOverride = activeProfile
    ? deps.config.profiles?.[activeProfile]?.contextTokenCap
    : undefined
  const cap = resolveContextCap(deps.model, profileOverride)
  const capResult = await deps.conversations.enforceTokenCap(
    targetChatId,
    deps.provider,
    cap,
  )
  setContextSize(capResult.after)

  // Ensure JSONL session exists for this chat
  const sessionId = await ensureSession(targetChatId, deps.sessionMapping, deps.model)

  // Per-user daily token budget gate (optional — v3.9 default is undefined).
  if (deps.tokenBudget) {
    const historyChars = history.reduce(
      (n, m) => n + JSON.stringify(m.content).length,
      0,
    )
    const estimate = Math.ceil(historyChars / 4) + 4_000
    const verdict = (deps.tokenBudget as { checkBudget: (userId: string, estimate: number) => string }).checkBudget(msg.authorId, estimate)
    if (verdict === 'exceeded') {
      const state = (deps.tokenBudget as { getState: (userId: string) => { usedToday: number; dailyTokens: number; resetAt: number } }).getState(msg.authorId)
      const dmText =
        `You've used ${state.usedToday}/${state.dailyTokens} tokens today. ` +
        `Budget resets at ${new Date(state.resetAt).toISOString()}.`
      await writer.replyError(dmText)
      return
    }
  }

  // Build SubagentParent — mirrors discord/turn-execution.ts pattern
  // with Telegram-specific ToolContext attribution fields (SEC-13).
  const toolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: deps.config.toolTimeoutMs,
    askUser: async () => '',
    checkPermission: async () => 'allow' as const,
    sessionId: `telegram-${targetChatId}`,
    mode: 'agent' as const,
    originalCwd: process.cwd(),
    source: 'telegram' as const,
    telegramUserId: msg.authorId,
    telegramChatId: targetChatId,
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

  // Phase 70 is text-only — no multimodal image blocks.
  const agentPrompt = content
  const agentInitialMessages = priorHistory.length > 0 ? priorHistory : undefined

  // SAND-02: defensive pre-spawn probe.
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
      await msg.replySend(escapeHtml(errMsg.slice(0, 4000)))
    } catch {
      // Channel reply is best-effort — never crash the Telegram handler
    }
    return
  }

  const result = await runSubagent(parent, agentPrompt, {
    initialMessages: agentInitialMessages,
    // PERS-01: per-chat system prompt builder.
    systemPrompt: deps.systemPrompt?.(targetChatId),
    // TGAGENT-02: accumulate streamed tokens into the writer's buffer.
    onTextChunk: (chunk: string) => {
      writer.appendChunk(chunk)
    },
    // TOKEN-01: capture per-turn token usage to usage store and audit log.
    onTurnComplete: (usage) => {
      const routedModel = parent.routerSession?.routedModel ?? deps.model
      const pricing = resolveModelPricing(routedModel, deps.config.telegram as never)
      const iterationCost = pricing
        ? (usage.inputTokens / 1_000_000) * pricing.inputPerMToken
          + (usage.outputTokens / 1_000_000) * pricing.outputPerMToken
        : 0
      agg.inputTokens += usage.inputTokens
      agg.outputTokens += usage.outputTokens
      agg.costUsd += iterationCost
      agg.cacheReadTokens += usage.cacheReadTokens
      agg.cacheCreationTokens += usage.cacheCreationTokens
      const record: UsageRecord = {
        ts: new Date().toISOString(),
        channelId: targetChatId,
        userId: msg.authorId,
        model: routedModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        turnId,
      }
      void appendUsage(record)
      void appendAuditEntry({
        ts: record.ts,
        kind: 'telegram_turn',
        sessionId: `telegram-${targetChatId}`,
        platform: process.platform,
        source: 'telegram',
        telegramUserId: msg.authorId,
        telegramChatId: targetChatId,
      })
    },
  })

  const responseText =
    result.text ||
    (result.error ? `Error: ${result.error.message}` : 'No response generated.')

  // Record assistant response for future turns
  deps.conversations.addAssistantMessage(targetChatId, responseText)

  // Persist new messages to JSONL (delta = everything after prior history)
  const priorLen = priorHistory.length + 1
  await persistTurnDelta(sessionId, priorLen, result.messages)

  // Chunk and send final response via the writer (edits placeholder +
  // posts follow-ups when chunk count > 1). writer.finalize escapes HTML
  // internally — TGAGENT-03 + TGAGENT-04 enforced inside the writer (Plan 02).
  await writer.finalize(responseText)
}
