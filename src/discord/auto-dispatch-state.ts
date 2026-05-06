/**
 * Phase 60 — Layer C auto-dispatch mutable state (D-09).
 *
 * This module is the SINGLE owner of all auto-dispatch mutable state per
 * CONTEXT decision D-09. Two Maps — `_pendingAutoDispatch` (channel → active
 * dispatch record) and `_cooldowns` (channel → turns remaining before next
 * dispatch allowed) — plus a small, explicit public API.
 *
 * Design note — immutability exception:
 *   CLAUDE.md mandates immutability (spread + return, never mutate). This
 *   module is the deliberate exception. Timer identity must be preserved
 *   across `set → clearTimeout → delete` transitions; replacing the Map on
 *   every mutation would break shutdown cleanup (clearAllPendingDispatches
 *   iterates the same Map that setPendingAutoDispatch populated). The Maps
 *   are module-scoped (not exported) and only mutable via the public API
 *   below. This mirrors the `_pendingPlanApproval` precedent in
 *   src/orchestration/discord.ts:108 (module-scoped resolver + timer pair).
 *
 * Scope — deliberately decoupled:
 *   - No imports from bot.ts, runner.ts, audit, or orchestration.
 *   - 60-03 (dispatch-intent.ts pure logic) reads hasPendingDispatch +
 *     checkCooldown; calls setPendingAutoDispatch + registerOrchestrationComplete.
 *   - 60-04 (bot.ts + runner.ts wiring) calls tryResolveAutoDispatchCancel
 *     (from DM router) + decrementCooldown (per USER message per D-10) +
 *     clearAllPendingDispatches (shutdown).
 *
 * Requirements mapping:
 *   - DISPATCH-05 → setPendingAutoDispatch, tryResolveAutoDispatchCancel, hasPendingDispatch
 *   - DISPATCH-06 → checkCooldown, decrementCooldown, registerOrchestrationComplete
 *   - DISPATCH-07 → exact-match `!cancel` in tryResolveAutoDispatchCancel (D-07)
 */

import { log } from '../log/logger.js'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One active auto-dispatch waiting on either the cancellation window timer
 * or a channel-scoped `!cancel` reply. Consumed by setPendingAutoDispatch,
 * tryResolveAutoDispatchCancel, and clearAllPendingDispatches.
 */
export type PendingRecord = {
  resolver: (cancel: boolean) => void
  timer: ReturnType<typeof setTimeout>
  dispatchedAt: number
}

// ── Module-scoped state (private — mutable only via exported functions) ──────

/**
 * Active auto-dispatch records, keyed by Discord channelId. Concurrent
 * dispatches across distinct channels are allowed (D-04). At most one
 * pending dispatch per channel — setPendingAutoDispatch overwrites.
 */
const _pendingAutoDispatch = new Map<string, PendingRecord>()

/**
 * Cooldown counter: channelId → turns remaining before the next auto-dispatch
 * on this channel is allowed. Decremented on every USER message (D-10). When
 * the counter reaches 0 (or the channel is absent), the channel is eligible
 * again.
 */
const _cooldowns = new Map<string, number>()

// ── Cooldown API (DISPATCH-06) ───────────────────────────────────────────────

/**
 * Returns true when the channel is in cooldown (refuse to dispatch).
 * Per D-10: counter > 0 means still cooling down.
 */
export function checkCooldown(channelId: string): boolean {
  return (_cooldowns.get(channelId) ?? 0) > 0
}

/**
 * Decrement the cooldown counter by 1 on every USER message (D-10 semantics).
 * Bounded at 0 (never goes negative). No-op when the channel has no cooldown.
 */
export function decrementCooldown(channelId: string): void {
  const current = _cooldowns.get(channelId) ?? 0
  if (current <= 0) return
  const next = current - 1
  if (next <= 0) {
    _cooldowns.delete(channelId)
  } else {
    _cooldowns.set(channelId, next)
  }
}

/**
 * Called by 60-03 after orchestration completes on a channel. Per D-10,
 * seeds cooldown to 2 turns so back-to-back auto-dispatches do not fire.
 */
export function registerOrchestrationComplete(channelId: string): void {
  _cooldowns.set(channelId, 2)
  log('debug', { channelId, turns: 2 }, 'auto-dispatch cooldown set')
}

// ── Pending dispatch API (DISPATCH-05, DISPATCH-07) ──────────────────────────

/**
 * Register a pending auto-dispatch for `channelId`. Starts a cancellation
 * window timer — when it elapses the resolver is invoked with `cancel=false`
 * (dispatch proceeds). The caller can also invoke cancel via
 * `tryResolveAutoDispatchCancel` on a `!cancel` message during the window.
 *
 * Per D-04: one pending dispatch per channel. If a pending record already
 * exists for this channel (should not happen in practice — dispatch-intent
 * checks `hasPendingDispatch` first), the previous timer is cleared and its
 * resolver is invoked with `cancel=true` so no awaiter is left hanging.
 *
 * @param channelId            Discord channelId (Map key).
 * @param resolver             Callback invoked exactly once with the outcome.
 *                             `true` = cancel (dispatch aborted);
 *                             `false` = window expired (dispatch proceeds).
 * @param cancellationWindowMs How long to wait for `!cancel` before auto-proceeding.
 * @param now                  Optional clock injector for tests (default: Date.now).
 */
export function setPendingAutoDispatch(
  channelId: string,
  resolver: (cancel: boolean) => void,
  cancellationWindowMs: number,
  now?: () => number,
): void {
  // Defensive: if a previous record exists, cancel it cleanly before overwriting.
  const previous = _pendingAutoDispatch.get(channelId)
  if (previous !== undefined) {
    clearTimeout(previous.timer)
    _pendingAutoDispatch.delete(channelId)
    previous.resolver(true)
  }

  const dispatchedAt = (now ?? Date.now)()
  const timer = setTimeout(() => {
    const record = _pendingAutoDispatch.get(channelId)
    if (record === undefined) return // already resolved (cancel or shutdown)
    _pendingAutoDispatch.delete(channelId)
    record.resolver(false) // cancel=false → dispatch proceeds
  }, cancellationWindowMs)

  _pendingAutoDispatch.set(channelId, { resolver, timer, dispatchedAt })
}

/**
 * Attempt to resolve a pending dispatch as cancelled. Returns true when the
 * message was consumed (pending existed AND content was exactly `!cancel`),
 * false otherwise (silent drop per D-05).
 *
 * Per D-07: exact-match, case-insensitive, trimmed. Any other content during
 * the window is passed through to the normal chat handler (returns false).
 */
export function tryResolveAutoDispatchCancel(channelId: string, content: string): boolean {
  const record = _pendingAutoDispatch.get(channelId)
  if (record === undefined) return false

  // D-07: strict equality with `!cancel` after trim + lowercase.
  if (content.trim().toLowerCase() !== '!cancel') return false

  clearTimeout(record.timer)
  _pendingAutoDispatch.delete(channelId)
  record.resolver(true) // cancel=true → dispatch aborted
  return true
}

/**
 * Helper for 60-03 (dispatch-intent.ts) to refuse a new auto-dispatch when
 * one is already pending on this channel. Returns true when a record exists.
 */
export function hasPendingDispatch(channelId: string): boolean {
  return _pendingAutoDispatch.has(channelId)
}

/**
 * Shutdown cleanup for bot.ts. Iterates all pending records, clears every
 * timer, invokes each resolver with `cancel=true` so no awaiter is left
 * hanging, then empties the Map. Mirrors the `_pendingWaveFailFast` cleanup
 * pattern at src/orchestration/discord.ts:738-745.
 */
export function clearAllPendingDispatches(): void {
  for (const record of _pendingAutoDispatch.values()) {
    clearTimeout(record.timer)
    record.resolver(true)
  }
  _pendingAutoDispatch.clear()
}

// ── Test helper ──────────────────────────────────────────────────────────────

/**
 * Clears both state Maps between tests. NOT for production use — it is the
 * only mutation path that bypasses the public API and exists solely so
 * `bun:test` beforeEach() hooks can guarantee no cross-test pollution.
 *
 * Composite: clears pending (including timers) THEN cooldowns, so no stray
 * timer can fire after reset.
 */
export function __resetForTests(): void {
  clearAllPendingDispatches()
  _cooldowns.clear()
}
