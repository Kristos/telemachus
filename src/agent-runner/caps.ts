/**
 * Phase 22 (AGENT-01): hard-cap primitives for the agent loop.
 *
 * Pure, side-effect-free, exhaustively tested. `runAgentLoop` calls
 * `checkCaps` at the top of every iteration; if it returns a non-null
 * reason the loop exits cleanly via `opts.onExit(reason)` and `return`.
 *
 * Design notes:
 * - Absent cap fields are treated as `Infinity` (no limit).
 * - Order of precedence when multiple caps fire simultaneously:
 *     iterations → wall_clock → tokens
 *   (deterministic — tests rely on this).
 * - `now` is injectable for tests; production callers omit it and get
 *   `Date.now()` at evaluation time.
 */

export type ExitReason = 'natural' | 'max_iterations' | 'max_wall_clock' | 'max_total_tokens'

export interface Caps {
  maxIterations?: number
  maxWallClockMs?: number
  maxTotalTokens?: number
}

export interface CapsState {
  iterations: number
  startedAt: number
  totalTokens: number
  /** Injected for deterministic tests; defaults to Date.now() at call time. */
  now?: number
}

export function checkCaps(
  state: CapsState,
  caps: Caps,
): Exclude<ExitReason, 'natural'> | null {
  const iterLimit = caps.maxIterations ?? Infinity
  if (state.iterations >= iterLimit) return 'max_iterations'

  const wallLimit = caps.maxWallClockMs ?? Infinity
  const now = state.now ?? Date.now()
  if (now - state.startedAt >= wallLimit) return 'max_wall_clock'

  const tokenLimit = caps.maxTotalTokens ?? Infinity
  if (state.totalTokens >= tokenLimit) return 'max_total_tokens'

  return null
}
