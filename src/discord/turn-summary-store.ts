/**
 * Phase 57 (MEAS-02, D-02): Per-Discord-turn aggregate cost JSONL store.
 *
 * Sibling of src/discord/usage-store.ts — UsageRecord captures one record
 * PER agent-loop iteration (raw token telemetry); TurnSummaryRecord captures
 * one record PER Discord turn (sum across iterations + dollar cost).
 *
 * Storage: ~/.telemachus/discord-turn-summaries/YYYY-MM-DD.jsonl
 *
 * Per D-03, this is NOT an audit event — audit log stays focused on
 * security/lifecycle. Cross-correlation between audit + turn-summary is
 * via shared turnId field.
 *
 * Phase 65 (HYG-03): mkdir→open→appendFile→datasync→close pipeline delegated
 * to the shared JsonlWriter class; public appendTurnSummary signature is unchanged.
 *
 * Best-effort: write failures go to log.warn, never throw. Fire-and-forget
 * (`void appendTurnSummary(...)`).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsonlWriter } from './jsonl-writer.js'

export interface TurnSummaryRecord {
  ts: string                  // ISO 8601 UTC, time of finally-block write
  turnId: string              // UUID matching SubagentParent.turnId
  channelId: string           // Discord channel/thread ID
  userId: string              // Discord author snowflake
  model: string               // Primary Discord profile model (e.g. "glm-4.6")
  totalInputTokens: number    // Summed across all loop iterations for this turn
  totalOutputTokens: number   // Summed across all loop iterations for this turn
  totalCostUsd: number        // Computed via resolveModelPricing(model, discordConfig)
  /**
   * COST-08 (Phase 61): measured input-context token count at the start of
   * the turn, BEFORE runSubagent runs. Captured via
   * `ConversationManager.getTokenEstimate` in Phase 61-02 and replaced by
   * `Provider.countTokens` in Phase 61-05 (COST-06). Optional so old JSONL
   * rows parse without forcing a migration. 234k-avg input tokens/turn
   * (v3.5-MILESTONE-REPORT §7) was invisible in the audit trail prior to
   * this field landing — 999.13 traceability.
   */
  contextSizeTokens?: number
  /**
   * CACHE-03 (Phase 64): summed Anthropic prompt-cache tokens across all
   * iterations in the turn. Both fields optional (COST-08 additive pattern)
   * so old JSONL rows parse. Only non-zero values are emitted — zero indicates
   * caching wasn't active or the turn was too short.
   *
   * cache_read: tokens served from ephemeral cache on this turn (cost savings).
   * cache_create: tokens written to cache on this turn (one-time write cost).
   */
  totalCacheReadTokens?: number
  totalCacheCreationTokens?: number
  /**
   * Reserved for Phase 58/59 expansion. Phase 57 plan 03 may set
   * compressionSavedTokens when stripping fires for the same turnId;
   * Phase 59 fills classifierTokens + routedTo.
   */
  layerBreakdown?: {
    compressionSavedTokens?: number  // Phase 58 + Phase 57 strip integration
    classifierTokens?: number        // Phase 59
    routedTo?: import('../config/types.js').IntentClass  // Phase 59 (widened to IntentClass in Phase 74)
  }
}

/**
 * Returns the path to the discord-turn-summaries directory.
 * Uses process.env.HOME when available so tests can redirect writes
 * to a temp directory without touching ~/.telemachus.
 */
export function summaryDir(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, '.telemachus', 'discord-turn-summaries')
}

/**
 * Returns the path to the JSONL file for a given date.
 */
export function summaryPath(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD UTC
  return join(summaryDir(), `${date}.jsonl`)
}

// Module-scoped writer. resolveDir/resolvePath are callbacks so tests that
// redirect HOME via process.env between calls still hit the redirected path.
const summaryWriter = new JsonlWriter({
  resolveDir: summaryDir,
  resolvePath: summaryPath,
  module: 'turn-summary-store',
  warnContext: (r) => ({ turnId: (r as TurnSummaryRecord).turnId }),
})

/**
 * Append a turn summary record to the date-partitioned JSONL file.
 * Fire-and-forget safe — errors go to log.warn, never throws.
 */
export async function appendTurnSummary(record: TurnSummaryRecord): Promise<void> {
  await summaryWriter.append(record)
}

/**
 * Parse a single JSONL line into a TurnSummaryRecord.
 * Returns null if the line is malformed or missing required fields.
 * layerBreakdown is optional and passed through when present.
 */
export function parseTurnSummaryLine(line: string): TurnSummaryRecord | null {
  if (!line || line.trim() === '') return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    // Validate all required fields are present with correct types
    if (
      typeof obj['ts'] !== 'string' ||
      typeof obj['turnId'] !== 'string' ||
      typeof obj['channelId'] !== 'string' ||
      typeof obj['userId'] !== 'string' ||
      typeof obj['model'] !== 'string' ||
      typeof obj['totalInputTokens'] !== 'number' ||
      typeof obj['totalOutputTokens'] !== 'number' ||
      typeof obj['totalCostUsd'] !== 'number'
    ) {
      return null
    }
    const layerBreakdown =
      obj['layerBreakdown'] && typeof obj['layerBreakdown'] === 'object'
        ? (obj['layerBreakdown'] as TurnSummaryRecord['layerBreakdown'])
        : undefined
    // COST-08: accept contextSizeTokens only when it's a finite number.
    // Non-number / NaN values are silently dropped (graceful tolerance) so a
    // bad write from a buggy ancestor doesn't poison downstream consumers.
    const rawCtx = obj['contextSizeTokens']
    const contextSizeTokens =
      typeof rawCtx === 'number' && Number.isFinite(rawCtx) ? rawCtx : undefined
    // CACHE-03 (Phase 64): accept totalCacheReadTokens / totalCacheCreationTokens
    // using the same finite-number guard. Zero-valued fields were not emitted
    // on write (finalizeTurnSummary spreads only >0), but we still tolerate them
    // on read for forward-compatibility.
    const rawCacheRead = obj['totalCacheReadTokens']
    const totalCacheReadTokens =
      typeof rawCacheRead === 'number' && Number.isFinite(rawCacheRead) ? rawCacheRead : undefined
    const rawCacheCreate = obj['totalCacheCreationTokens']
    const totalCacheCreationTokens =
      typeof rawCacheCreate === 'number' && Number.isFinite(rawCacheCreate) ? rawCacheCreate : undefined
    return {
      ts: obj['ts'],
      turnId: obj['turnId'],
      channelId: obj['channelId'],
      userId: obj['userId'],
      model: obj['model'],
      totalInputTokens: obj['totalInputTokens'],
      totalOutputTokens: obj['totalOutputTokens'],
      totalCostUsd: obj['totalCostUsd'],
      ...(contextSizeTokens !== undefined ? { contextSizeTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheCreationTokens !== undefined ? { totalCacheCreationTokens } : {}),
      ...(layerBreakdown !== undefined ? { layerBreakdown } : {}),
    }
  } catch {
    return null
  }
}
