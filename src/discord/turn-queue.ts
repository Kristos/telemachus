/**
 * Phase 65 (HYG-01): Extracted from runner.ts — per-channel promise queue
 * + drain/shutdown lifecycle.
 * Phase 65 (HYG-02): Swapped the unbounded channelQueues Map for
 *   ChannelQueueLRU — entries idle >1h are swept every 5min so long-running
 *   deployments no longer accumulate stale per-DM / per-thread Promise refs.
 *
 * Responsibilities:
 *   - channelQueues (ChannelQueueLRU) — serializes turns within one Discord
 *     channel so concurrent runs don't corrupt ConversationManager state.
 *   - activeTurns counter — observable pending-work state for SIGTERM drain.
 *   - draining sentinel — silently drop new work during shutdown.
 *   - enqueue(channelId, fn) — chain fn onto the channel's tail promise.
 *
 * External API (enqueue, drainAllTurns, hasPendingTurns, setDraining) is
 * UNCHANGED from the 65-01 version — the LRU is drop-in. Tests that grepped
 * for `channelQueues instanceof Map` are updated to assert the LRU shape.
 */
import { ChannelQueueLRU } from './channel-queue-lru.js'

/**
 * Per-channel promise queue — serializes agent turns within one channel.
 * Prevents concurrent runs from corrupting ConversationManager state.
 *
 * LRU-backed: auto-evicts channel entries idle longer than 1h every 5min.
 * startSweep is kicked on module import so long-running runners get eviction
 * for free; tests that need a stopped sweep call stopSweep() in afterAll.
 */
export const channelQueues = new ChannelQueueLRU()
channelQueues.startSweep()

/**
 * UPDATE-07: Active turn counter — tracks how many turns are currently
 * in-flight (enqueued but not yet completed). Incremented when a turn starts,
 * decremented when it settles. Used by hasPendingTurns() for accurate state.
 */
let activeTurns = 0

/**
 * UPDATE-07: Drain sentinel flag. When true, new enqueue() calls are silently
 * dropped — the bot stops accepting new work during SIGTERM shutdown.
 */
let draining = false

/**
 * UPDATE-07: Enable or disable the drain sentinel.
 * - setDraining(true): stop accepting new messages immediately (call on SIGTERM)
 * - setDraining(false): re-enable (useful for test reset)
 */
export function setDraining(enabled: boolean): void {
  draining = enabled
}

/**
 * UPDATE-07: Check whether there are any in-flight channel turns.
 *
 * Uses the activeTurns counter which is incremented/decremented as turns
 * start and settle, giving an accurate pending count without needing to
 * inspect Promise state.
 */
export function hasPendingTurns(): boolean {
  return activeTurns > 0
}

/**
 * UPDATE-07: Wait for all in-flight channel turns to settle, up to timeoutMs.
 *
 * Uses Promise.allSettled so that individual failures don't block the drain.
 * Race against a timeout so SIGTERM never hangs indefinitely.
 */
export function drainAllTurns(timeoutMs: number): Promise<void> {
  const pending = [...channelQueues.values()]
  if (pending.length === 0) return Promise.resolve()
  return Promise.race([
    Promise.allSettled(pending).then(() => { return }),
    new Promise<void>(r => {
      const t = setTimeout(r, timeoutMs)
      if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref()
    }),
  ])
}

/**
 * Chain `fn` onto the tail promise for `channelId`, serializing it behind
 * any prior in-flight turn for the same channel. Tracks activeTurns for
 * hasPendingTurns / drainAllTurns observability. Silently no-ops when
 * draining is active (SIGTERM shutdown path).
 *
 * Returns void — caller doesn't await; failures are swallowed via
 * `prev.then(fn, fn)` so one error never stalls the channel.
 */
/**
 * Reset all module-level state for test isolation.
 * Call in beforeEach/afterEach to prevent cross-test contamination from
 * enqueue() calls that leave pending promises in channelQueues.
 *
 * NOT intended for production use — only exported for test reset.
 */
export function resetQueueForTest(): void {
  channelQueues.clear()
  activeTurns = 0
  draining = false
}

export function enqueue(channelId: string, fn: () => Promise<void>): void {
  if (draining) return  // UPDATE-07: reject new work during shutdown

  const prev = channelQueues.getOrInitTail(channelId)
  // Track this turn as active — decremented when it settles
  activeTurns++
  // Run fn regardless of prior rejection so one error doesn't stall the channel
  const next = prev.then(fn, fn).finally(() => {
    activeTurns = Math.max(0, activeTurns - 1)
    // CAS-style cleanup — only remove when we're still the tail (LRU
    // instance handles staleness sweep separately).
    channelQueues.deleteIfMatches(channelId, next)
  })
  channelQueues.setTail(channelId, next)
}
