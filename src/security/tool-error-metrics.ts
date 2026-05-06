/**
 * Phase 63 (OBS-02): Rolling failure metric for tool_error events.
 *
 * Pure in-memory module consumed by OBS-03 (DM alert watcher), OBS-04 (daily
 * summary), and OBS-05 (`!tool-errors` Discord command). No I/O, no Discord
 * imports, no audit-emission imports (the AuditEntry type alone is used for
 * shape).
 *
 * Design note — immutability exception:
 *   CLAUDE.md mandates immutability (spread + return, never mutate). This
 *   module is a deliberate exception: a bounded ring buffer whose identity
 *   must persist across recordError calls and whose __resetForTests helper
 *   must clear the same slot it populates. Replacing the array on every
 *   push would break the replay + live-feed interleaving OBS-03 needs on
 *   bot startup. This mirrors src/discord/auto-dispatch-state.ts precedent.
 *
 * Decision log:
 *   - `totalRate` (denominator of error_rate = errors/total) was DROPPED in
 *     favor of `totalErrors` (absolute count). Reason: OBS-03 only needs the
 *     "N errors in window" threshold, and keeping a parallel success counter
 *     here would force consumers to feed every tool_call into this module
 *     too, violating its "failures-only" charter. OBS-03 can still compute
 *     a rate externally if needed.
 *   - `getRecentErrorsForWindow(entries, windowMs, now)` exposed as a PURE
 *     helper used by OBS-04 daily-summary assembly — lets the scheduler
 *     snapshot 24h from audit JSONL without mutating the live ring buffer.
 *
 * Ring buffer bounds:
 *   - MAX_SAMPLES = 1000 (count cap — evict oldest when exceeded)
 *   - MAX_AGE_MS  = 3_600_000 (1h cap — prune on every insert)
 *   Whichever hits first evicts.
 */
import type { AuditEntry } from './audit.js'

export interface ToolErrorSample {
  ts: number // epoch ms (parsed from entry.ts)
  tool: string
  errorClass: string
  errorMessage: string
  channelId?: string
  turnId?: string
}

const MAX_SAMPLES = 1000
const MAX_AGE_MS = 60 * 60 * 1000

// Module-scoped mutable ring buffer (see immutability exception above).
const _samples: ToolErrorSample[] = []

/**
 * Internal: convert an AuditEntry into a ToolErrorSample or null if the
 * entry does not qualify (wrong kind, missing tool, unparseable ts).
 */
function toSample(entry: AuditEntry): ToolErrorSample | null {
  if (entry.kind !== 'tool_error') return null
  if (!entry.tool) return null
  const ts = Date.parse(entry.ts)
  if (Number.isNaN(ts)) return null
  const out: ToolErrorSample = {
    ts,
    tool: entry.tool,
    errorClass: entry.errorClass ?? 'Unknown',
    errorMessage: entry.errorMessage ?? '',
  }
  if (entry.channelId !== undefined) out.channelId = entry.channelId
  if (entry.turnId !== undefined) out.turnId = entry.turnId
  return out
}

/**
 * Evict entries that are either older than MAX_AGE_MS relative to `now`, OR
 * that exceed MAX_SAMPLES when the buffer is too long. Both bounds apply on
 * every insert so neither can drift out of shape under sustained load.
 */
function prune(now: number): void {
  const cutoff = now - MAX_AGE_MS
  // Age prune — find first index where ts >= cutoff. Samples are inserted in
  // time-of-record order, not strictly sorted by entry.ts (replay can push
  // older entries after live-feed); to be safe we do an in-place filter.
  let writeIdx = 0
  for (let readIdx = 0; readIdx < _samples.length; readIdx++) {
    const s = _samples[readIdx]!
    if (s.ts >= cutoff) {
      if (writeIdx !== readIdx) _samples[writeIdx] = s
      writeIdx++
    }
  }
  _samples.length = writeIdx
  // Count prune — evict oldest-by-insertion until under cap
  while (_samples.length > MAX_SAMPLES) {
    _samples.shift()
  }
}

export function recordError(event: AuditEntry, now?: () => number): void {
  const sample = toSample(event)
  if (sample === null) return
  _samples.push(sample)
  prune((now ?? Date.now)())
}

export function ratePerTool(windowMs: number, now?: () => number): Map<string, number> {
  const cutoff = (now ?? Date.now)() - windowMs
  const out = new Map<string, number>()
  for (const s of _samples) {
    if (s.ts < cutoff) continue
    out.set(s.tool, (out.get(s.tool) ?? 0) + 1)
  }
  return out
}

export function totalErrors(windowMs: number, now?: () => number): number {
  const cutoff = (now ?? Date.now)() - windowMs
  let n = 0
  for (const s of _samples) {
    if (s.ts >= cutoff) n++
  }
  return n
}

export function getRecentErrors(
  windowMs: number,
  limit = 10,
  now?: () => number,
): ToolErrorSample[] {
  const cutoff = (now ?? Date.now)() - windowMs
  const filtered = _samples.filter((s) => s.ts >= cutoff)
  // Sort newest first (stable by ts desc)
  filtered.sort((a, b) => b.ts - a.ts)
  return filtered.slice(0, limit)
}

/**
 * Pure helper (OBS-04): compute a recent-errors list from an EXTERNAL array
 * of audit entries without touching the module-scoped live buffer. Used by
 * the daily-summary scheduler to snapshot 24h from audit JSONL without
 * conflicting with the watcher's in-flight buffer state.
 */
export function getRecentErrorsForWindow(
  entries: AuditEntry[],
  windowMs: number,
  now?: () => number,
): ToolErrorSample[] {
  const cutoff = (now ?? Date.now)() - windowMs
  const samples: ToolErrorSample[] = []
  for (const entry of entries) {
    const s = toSample(entry)
    if (s !== null && s.ts >= cutoff) samples.push(s)
  }
  samples.sort((a, b) => b.ts - a.ts)
  return samples
}

export function replay(entries: AuditEntry[], now?: () => number): void {
  for (const entry of entries) {
    recordError(entry, now)
  }
}

// ── Test helper ──────────────────────────────────────────────────────────────

/**
 * Clears the ring buffer between tests. NOT for production — the only mutation
 * path that bypasses the public API. Mirrors auto-dispatch-state.ts precedent.
 */
export function __resetForTests(): void {
  _samples.length = 0
}
