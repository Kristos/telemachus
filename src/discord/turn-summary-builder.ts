/**
 * Phase 65 (HYG-01): Extracted from runner.ts — pure helper to build a
 * TurnSummaryRecord from turn metrics and the routerSession accumulator.
 *
 * Separated so error-boundary.ts can depend on it without pulling the
 * entire runner.ts orchestrator. Also exported from runner.ts for
 * backward-compat (existing tests import from ./runner.js).
 *
 * Rules:
 *  - If routerSession has any populated fields, include them in layerBreakdown.
 *  - Never emit undefined-valued keys in the breakdown object.
 *  - If no fields are populated, omit layerBreakdown entirely.
 */
import type { TurnSummaryRecord } from './turn-summary-store.js'

/**
 * Phase 59 (D-12): Pure helper — build a TurnSummaryRecord from turn metrics
 * and the routerSession accumulator. Extracted for unit-testability.
 */
export function finalizeTurnSummary(
  turnId: string,
  agg: {
    inputTokens: number
    outputTokens: number
    costUsd: number
    // CACHE-03 (Phase 64): optional cache token aggregates — additive schema
    // extension following the COST-08 pattern. Only emitted when > 0.
    cacheReadTokens?: number
    cacheCreationTokens?: number
  },
  routerSession: { routedTo?: import('../config/types.js').IntentClass; classifierTokens?: number },
  meta: { channelId: string; userId: string; model: string; contextSizeTokens?: number },
): TurnSummaryRecord {
  const breakdown: NonNullable<TurnSummaryRecord['layerBreakdown']> = {}
  if (routerSession.routedTo !== undefined) breakdown.routedTo = routerSession.routedTo
  if (routerSession.classifierTokens !== undefined) breakdown.classifierTokens = routerSession.classifierTokens
  const hasBreakdown = Object.keys(breakdown).length > 0

  return {
    ts: new Date().toISOString(),
    turnId,
    channelId: meta.channelId,
    userId: meta.userId,
    model: meta.model,
    totalInputTokens: agg.inputTokens,
    totalOutputTokens: agg.outputTokens,
    totalCostUsd: agg.costUsd,
    // COST-08 (Phase 61): input-context size measured BEFORE runSubagent,
    // so this value reflects what the LLM actually received (not any mid-turn
    // compression). Optional to preserve old JSONL parsing.
    ...(meta.contextSizeTokens !== undefined ? { contextSizeTokens: meta.contextSizeTokens } : {}),
    // CACHE-03 (Phase 64): only emit cache fields when > 0. Zero is indistinguishable
    // from absence for consumers and would clutter every non-Anthropic record.
    ...(agg.cacheReadTokens !== undefined && agg.cacheReadTokens > 0
      ? { totalCacheReadTokens: agg.cacheReadTokens }
      : {}),
    ...(agg.cacheCreationTokens !== undefined && agg.cacheCreationTokens > 0
      ? { totalCacheCreationTokens: agg.cacheCreationTokens }
      : {}),
    ...(hasBreakdown ? { layerBreakdown: breakdown } : {}),
  }
}
