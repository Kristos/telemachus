/**
 * Phase 69: Telegram per-chat promise queue + drain/shutdown lifecycle.
 * Independent copy of src/discord/turn-queue.ts so Telegram and Discord can
 * each maintain their own activeTurns counter and draining sentinel without
 * coupling shutdown sequences.
 *
 * Re-uses ChannelQueueLRU from the Discord module (it is generic).
 *
 * External API (enqueue, drainAllTurns, hasPendingTurns, setDraining) matches
 * the Discord version 1:1; callers can swap modules cleanly.
 */
import { ChannelQueueLRU } from '../discord/channel-queue-lru.js'

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
