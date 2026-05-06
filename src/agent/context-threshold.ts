/**
 * Pure threshold check for auto-compact.
 *
 * @param ctxPct - Current context fill as 0..1 fraction
 * @param thresholdPercent - Trigger threshold as integer percent (0-100)
 * @returns true when ctxPct meets or exceeds the threshold
 */
export function shouldAutoCompact(ctxPct: number, thresholdPercent: number): boolean {
  if (typeof ctxPct !== 'number' || Number.isNaN(ctxPct) || ctxPct < 0) return false
  if (thresholdPercent > 100) return false
  return ctxPct * 100 >= thresholdPercent
}
