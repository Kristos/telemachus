/**
 * Phase 65 (HYG-01): Extracted from runner.ts — per-turn try/catch/finally
 * wrapper. Centralizes the error-reply + finally-block turn_summary write
 * that every Discord turn must execute.
 *
 * Responsibilities:
 *   - Run the user-supplied body closure inside a try block.
 *   - On error: format the Agent error: {msg} string and route it through
 *     writer.replyError so the user sees something, log-and-swallow if the
 *     channel itself is broken.
 *   - In finally: stop the reply writer (clears typing, clears edit interval),
 *     then write one TurnSummaryRecord per turn when aggregated usage > 0.
 *     Uses getContextSizeTokens() at finally-time so the value reflects the
 *     post-cap measurement even when assignment happened deep in the body.
 *
 * Closure-safety: contextSizeTokens is passed via a getter callback rather
 * than direct parameter so the boundary reads the latest closure-scoped
 * value. This prevents the TDZ issue from Phase 64 deferred-items from
 * recurring — body can assign contextSizeTokens at any point and the
 * boundary will read the current value when the finally block fires.
 */
import { finalizeTurnSummary } from './turn-summary-builder.js'
import { appendTurnSummary, type TurnSummaryRecord } from './turn-summary-store.js'
import { log } from '../log/logger.js'
import type { ReplyWriter } from './reply-writer.js'

export interface TurnAgg {
  inputTokens: number
  outputTokens: number
  costUsd: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface RouterSession {
  routedTo?: import('../config/types.js').IntentClass
  routedModel?: string
  classifierTokens?: number
}

export interface TurnContext {
  writer: ReplyWriter
  turnId: string
  agg: TurnAgg
  routerSession: RouterSession
  channelId: string
  userId: string
  /** Fallback model when routerSession.routedModel is undefined (CLI path). */
  defaultModel: string
  /** TRAJ-01: transport identity for signal record. */
  transport: 'discord' | 'telegram'
  /**
   * Read the closure-scoped contextSizeTokens at finally-time. Returning
   * undefined means the cap hasn't been measured yet (e.g. turn threw
   * before enforceTokenCap ran) — the summary field is omitted in that case.
   */
  getContextSizeTokens: () => number | undefined
}

/**
 * Wrap a per-turn body with the standard error-reply + turn-summary finally
 * handling. The body is responsible for all agent-loop work (compression,
 * addUserMessage, enforceTokenCap, runSubagent, finalize reply). This
 * boundary owns only the error path and the summary write.
 */
export async function wrapTurnExecution(
  ctx: TurnContext,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await ctx.writer.replyError(`Agent error: ${errMsg}`)
  } finally {
    ctx.writer.stop()
    // Phase 57 (MEAS-02): one TurnSummaryRecord per Discord turn, even on error
    // Phase 59 (D-12): include layerBreakdown when RouterProvider populated
    // routerSession. Mirrors Phase 55 USAGE-01 partial-usage-on-abort handling.
    if (ctx.agg.inputTokens > 0 || ctx.agg.outputTokens > 0) {
      try {
        const summary: TurnSummaryRecord = finalizeTurnSummary(
          ctx.turnId,
          {
            inputTokens: ctx.agg.inputTokens,
            outputTokens: ctx.agg.outputTokens,
            costUsd: ctx.agg.costUsd,
            cacheReadTokens: ctx.agg.cacheReadTokens,
            cacheCreationTokens: ctx.agg.cacheCreationTokens,
          },
          ctx.routerSession,
          {
            channelId: ctx.channelId,
            userId: ctx.userId,
            // Phase 59.1 (FIX-ROUTER-03): honor routed model via routerSession
            // with fallback to the default (CLI/agent-runner) model.
            model: ctx.routerSession.routedModel ?? ctx.defaultModel,
            contextSizeTokens: ctx.getContextSizeTokens(),
          },
        )
        void appendTurnSummary(summary)
        // TRAJ-01: write routing signal record if RouterProvider was active this turn
        if (ctx.routerSession.routedTo !== undefined) {
          const { appendSignal } = await import('../shared/trajectory.js')
          void appendSignal({
            ts: new Date().toISOString(),
            transport: ctx.transport,
            type: 'auto',
            intent: ctx.routerSession.routedTo,
            model: ctx.routerSession.routedModel ?? ctx.defaultModel,
            costUsd: ctx.agg.costUsd,
            outputTokens: ctx.agg.outputTokens,
          })
        }
      } catch (summaryErr) {
        // Never let a summary-write failure crash the handler.
        log('error', {
          module: 'error-boundary',
          source: 'discord',
          turnId: ctx.turnId,
          error: summaryErr instanceof Error ? summaryErr.message : String(summaryErr),
        }, 'failed to write turn summary')
      }
    }
  }
}
