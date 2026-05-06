/**
 * Phase 31 (DISC-01–04, SEC-13): Discord ↔ agent-loop adapter.
 * Phase 33 (JOB-01–03): Command interception for !run / !status.
 *
 * handleDiscordMessage is the single entry point that:
 *   - Intercepts !run / !status commands BEFORE the agent loop (JOB-01)
 *   - Creates a thread for guild @mentions (DISC-02)
 *   - Serializes turns within a channel via a promise queue
 *   - Runs the full agent loop via runSubagent with multi-turn context (DISC-01)
 *   - Keeps the typing indicator alive during the run (DISC-03)
 *   - Splits responses >2000 chars before sending (DISC-04)
 *   - Propagates Discord source fields to audit entries (SEC-13)
 */
import { randomUUID } from 'node:crypto'
import type { Provider } from '../providers/types.js'
import { resolveModelPricing } from '../usage/pricing.js'
import * as sandboxEnvModule from './sandbox-env.js'
import { finalizeTurnSummary as _finalizeTurnSummary } from './turn-summary-builder.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import { ConversationManager } from './conversation.js'
import { isCommand, handleCommand } from './commands.js'
import type { RunJobMcpManager } from '../agent-runner/run-job.js'
import { formatDuration } from '../agent-runner/status.js'
import { log } from '../log/logger.js'
import { DiscordTokenBudget } from './token-budget.js'
import {
  normalizeIncomingMessage,
  type DiscordMessage,
  type DiscordAttachment,
} from './message-intake.js'
import {
  enqueue,
  setDraining as _setDraining,
  hasPendingTurns as _hasPendingTurns,
  drainAllTurns as _drainAllTurns,
  resetQueueForTest as _resetQueueForTest,
} from './turn-queue.js'
import { createReplyWriter } from './reply-writer.js'
import { wrapTurnExecution } from './error-boundary.js'
import { runTurnBody } from './turn-execution.js'
// Phase 60 (DISPATCH-01, 05, 06, 07): auto-dispatch intent + state modules.
// Imported as namespaces so tests can spyOn individual functions without
// mock.module (bun:test spyOn intercepts namespace-member calls at runtime).
import * as dispatchIntentModule from './dispatch-intent.js'
import * as autoDispatchStateModule from './auto-dispatch-state.js'
import { handleAutoDispatch } from './auto-dispatch-flow.js'

/**
 * HYG-01 (Phase 65): SAND-04 HOME/CWD wiring moved to sandbox-env.ts.
 * Re-exported here so existing consumers (SAND-04 tests + bot startup path)
 * continue to work.
 */
export const findProjectRoot = sandboxEnvModule.findProjectRoot
export const __resetSandboxEnvForTest = sandboxEnvModule.__resetSandboxEnvForTest
export const initSandboxEnv = sandboxEnvModule.initSandboxEnv

/**
 * HYG-01 (Phase 65): finalizeTurnSummary moved to turn-summary-builder.ts
 * so error-boundary.ts can consume it directly. Re-exported here for
 * backward compat (existing tests import from ./runner.js).
 */
export const finalizeTurnSummary = _finalizeTurnSummary

export interface DiscordRunnerDeps {
  config: KristosConfig
  provider: Provider
  registry: ToolRegistry
  conversations: ConversationManager
  /**
   * Phase 64 (PERS-01): builder that returns the per-channel system prompt.
   * Called fresh for every incoming message so persona changes via config
   * reload take effect without a bot restart — for the current message onward.
   * Prior shape was `systemPrompt?: string`; changed to a builder so each
   * channel gets its configured persona injected from DiscordConfig.personas.
   */
  systemPrompt?: (channelId: string) => string
  /** Live reference to the channel→session mapping (mutated by ensureSession) */
  sessionMapping: Record<string, string>
  /** Model name for session metadata */
  model: string
  /**
   * Phase 33 (JOB-01): MCP manager passed through to background job runners
   * spawned by !run commands. Optional — when absent, MCP lifecycle is skipped.
   */
  mcpManager?: RunJobMcpManager
  /**
   * Phase 33 (JOB-03): Optional function to post job results to a specific
   * channel. When absent, results are posted back to the channel where !run
   * was invoked via msg.reply.
   */
  sendToChannel?: (channelId: string, text: string) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): sendDm function for escalation DMs during
   * !orchestrate runs. Passed through to CommandDeps → handleOrchestrateCommand.
   */
  sendDm?: (userId: string, text: string) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): Discord user ID of the bot owner.
   * Required when sendDm is provided for escalation DMs.
   */
  ownerId?: string
  /**
   * Phase 56 (BUDGET-01): Per-user daily token budget tracker.
   * When present, checkBudget is called before every runSubagent invocation.
   * On exceeded: user is DM'd (or replied to) and turn is refused.
   */
  tokenBudget?: DiscordTokenBudget
}

/**
 * HYG-01 (Phase 65): DiscordMessage + DiscordAttachment types and attachment
 * fetching were extracted to message-intake.ts. Re-exported here so existing
 * consumers (`import { DiscordMessage } from './runner.js'`) continue to work.
 */
export type { DiscordMessage, DiscordAttachment } from './message-intake.js'

/**
 * HYG-01 (Phase 65): per-channel queue + drain lifecycle moved to
 * turn-queue.ts. Re-exported here so existing consumers
 * (`import { setDraining, drainAllTurns, hasPendingTurns } from './runner.js'`)
 * continue to work. Plan 65-02 (HYG-02) swaps the Map for ChannelQueueLRU
 * inside turn-queue.ts without changing the public surface here.
 */
export const setDraining = _setDraining
export const hasPendingTurns = _hasPendingTurns
export const drainAllTurns = _drainAllTurns
export const resetQueueForTest = _resetQueueForTest

/**
 * Phase 57 (MEAS-03): Pure helper — compute the USD cost for one agent-loop
 * iteration using the override-aware resolveModelPricing. Exported so unit
 * tests can verify the pricing math without running the full agent loop.
 *
 * Returns 0 when model is unknown to both DiscordConfig.pricing and PRICING_TABLE.
 */
export function computeIterationCost(
  usage: { inputTokens: number; outputTokens: number },
  model: string,
  discordConfig?: { pricing?: Record<string, { input: number; output: number }> },
): number {
  const pricing = resolveModelPricing(model, discordConfig)
  if (!pricing) return 0
  return (usage.inputTokens / 1_000_000) * pricing.inputPerMToken
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMToken
}

/**
 * Build the DiscordMessage handler. Returns a function that processes one
 * Discord message through the full agent loop.
 *
 * Usage:
 *   const onMessage = handleDiscordMessage(deps)
 *   // then: onMessage(discordMsg)
 */
export function handleDiscordMessage(deps: DiscordRunnerDeps) {
  return async (msg: DiscordMessage): Promise<void> => {
    // Phase 62 (SAND-04): initialize HOME + KC_PROJECT_ROOT env on first
    // Discord message. Idempotent — subsequent messages no-op. Prevents
    // silent tool-layer degradation when launchd plist strips HOME.
    // Call through the namespace import so tests can spyOn sandbox-env
    // to suppress the HOME flip during integration runs.
    sandboxEnvModule.initSandboxEnv()

    // JOB-01: Intercept !run / !status commands BEFORE any thread creation or
    // agent loop. Commands complete synchronously (reply sent within 3 seconds).
    if (isCommand(msg.content)) {
      await handleCommand(msg, {
        config: deps.config,
        provider: deps.provider,
        registry: deps.registry,
        mcpManager: deps.mcpManager,
        // Phase 40-03: thread sendDm and ownerId for !orchestrate escalation DMs
        sendDm: deps.sendDm,
        ownerId: deps.ownerId,
        // Phase 54: thread conversations so !orchestrate can append summary turns
        conversations: deps.conversations,
        onJobComplete: async (channelId, jobName, result) => {
          // JOB-03: Post result summary to the originating channel (or a
          // configured results channel if deps.sendToChannel is wired).
          const exitEmoji = result.error ? '!' : (result.exitReason === 'natural' ? '=' : '~')
          const errorLine = result.error ? `\nError: ${result.error.message}` : ''
          const summary = [
            `**Job \`${jobName}\` complete** [${exitEmoji}]`,
            `Exit: ${result.exitReason} | Duration: ${formatDuration(result.durationMs)} | Turns: ${result.turnCount}`,
            errorLine,
            result.runDir ? `Artifacts: \`${result.runDir}\`` : '',
          ].filter(Boolean).join('\n')
          try {
            if (deps.sendToChannel) {
              await deps.sendToChannel(channelId, summary)
            } else {
              await msg.reply(summary)
            }
          } catch {
            log('error', { module: 'discord-runner', source: 'discord', jobName, discordChannelId: channelId }, 'failed to post job result')
          }
        },
      })
      return  // command handled — skip agent loop entirely
    }

    // Phase 60 (D-10): decrement cooldown counter on every USER message
    // (commands excluded, hence after the isCommand early-return). Bounded
    // at 0 by auto-dispatch-state; no-op on channels without active cooldown.
    // Uses msg.channelId (pre-thread) because auto-dispatch state is keyed
    // by originating channel, not by any thread we may create downstream.
    autoDispatchStateModule.decrementCooldown(msg.channelId)

    // Phase 60 (DISPATCH-01): check auto-dispatch BEFORE enqueue. Default-off
    // per DISPATCH-08 — when disabled, short-circuit with zero observable work.
    // Fast-path gates (disabled/no_keyword) emit no audit so normal chat
    // traffic has zero observability cost.
    if (deps.config.discord?.autoDispatch?.enabled === true && deps.tokenBudget) {
      const dispatchTurnId = randomUUID()
      const dispatchResult = await dispatchIntentModule.maybeAutoDispatch({
        content: msg.content,
        channelId: msg.channelId,
        userId: msg.authorId,
        budget: deps.tokenBudget,
        config: deps.config.discord,
        turnId: dispatchTurnId,
        sessionId: `discord-${msg.channelId}`,
        platform: process.platform,
      })
      if (dispatchResult.dispatch === true) {
        // Route to auto-dispatch flow (ack + cancellation window + orchestration).
        // The handleAutoDispatch helper handles its own errors and always
        // calls registerOrchestrationComplete in finally (D-10).
        return handleAutoDispatch(msg, deps, msg.channelId)
      }
      // For dispatch:false, all audit emission already happened inside
      // maybeAutoDispatch (60-03). Fall through to normal enqueue path.
    }

    // HYG-01 (Phase 65): guild→thread routing + attachment fetching moved
    // to message-intake.ts. Normalize BEFORE enqueue so the returned
    // targetChannelId selects the correct per-channel queue.
    const intake = await normalizeIncomingMessage(msg)
    const { targetChannelId, replySend, replySendTyping, enrichedContent, imageBlocks } = intake

    enqueue(targetChannelId, async () => {
      // Phase 57 (MEAS-01): one UUID per Discord turn, threaded into SubagentParent
      // and later joined to UsageRecord and TurnSummaryRecord for cost aggregation.
      const turnId = randomUUID()
      // Phase 59 (D-12): RouterProvider mutates this object during its per-turn
      // decision; the error-boundary reads it in the finally-block to populate
      // turn_summary.layerBreakdown. Empty object → no breakdown (non-router path).
      const routerSession: {
        routedTo?: import('../config/types.js').IntentClass
        routedModel?: string
        classifierTokens?: number
      } = {}
      // Phase 57 (MEAS-02): per-turn token+cost accumulator.
      // Phase 64 (CACHE-03): cacheReadTokens + cacheCreationTokens accumulated too.
      const agg = { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }

      // HYG-01 (Phase 65): hoisted so the error-boundary's finally-block
      // getContextSizeTokens() callback can read it regardless of where (or if)
      // the body assigns. Fixes the pre-existing TDZ ReferenceError from
      // Phase 64 deferred-items.md.
      let contextSizeTokens: number | undefined = undefined

      // HYG-01 (Phase 65): streaming reply state (typing keep-alive, editable
      // placeholder, 1.2s edit interval, chunked final send) lives in
      // reply-writer.ts. start() primes the typing indicator + placeholder.
      const writer = createReplyWriter({
        msg,
        replySend,
        replySendTyping,
        userId: msg.authorId,
        channelId: targetChannelId,
      })
      await writer.start()

      await wrapTurnExecution(
        {
          writer,
          turnId,
          agg,
          routerSession,
          channelId: targetChannelId,
          userId: msg.authorId,
          defaultModel: deps.model,
          transport: 'discord',
          getContextSizeTokens: () => contextSizeTokens,
        },
        () => runTurnBody({
          deps,
          msg,
          writer,
          targetChannelId,
          turnId,
          routerSession,
          agg,
          enrichedContent,
          imageBlocks,
          setContextSize: (tokens) => { contextSizeTokens = tokens },
        }),
      )
    })
  }
}
