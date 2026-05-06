/**
 * Phase 65 (HYG-02): Map-backed per-channel promise tail tracker with
 * automatic idle-eviction. Drop-in replacement for the unbounded
 * `channelQueues = new Map<string, Promise<void>>()` in turn-queue.ts.
 *
 * Problem: 24h of representative Discord traffic accumulates one Map entry per
 * DM and per thread the bot has ever serviced — a slow leak that eventually
 * holds hundreds of resolved Promise references. TTL=1h matches the natural
 * rhythm of Discord conversations (replies hours later are rare; new threads
 * are cheap to rehydrate from a fresh Promise.resolve()).
 *
 * Design — immutability exception:
 *   Mutable internal `entries` Map mirrors the pattern established in
 *   src/discord/auto-dispatch-state.ts — timer identity and entry-by-entry
 *   CAS-style removal (`deleteIfMatches`) make replacing the Map on every
 *   mutation structurally impossible.
 *
 * Scope:
 *   - No dependencies on runner/bot/audit — pure data structure.
 *   - startSweep uses setInterval (not unref'd); turn-queue.ts owns the
 *     module-scoped instance so lifecycle mirrors the Discord runner.
 */

export interface ChannelQueueLRUOpts {
  /** Idle TTL in ms. Entries untouched for longer are evicted by sweep. Default 1h. */
  maxIdleMs?: number
  /** Interval between automatic sweeps when startSweep() is active. Default 5min. */
  sweepIntervalMs?: number
  /** Override for Date.now — makes sweep/eviction tests deterministic. */
  nowFn?: () => number
}

interface Entry {
  tail: Promise<void>
  lastTouched: number
}

export class ChannelQueueLRU {
  private readonly entries = new Map<string, Entry>()
  private readonly maxIdleMs: number
  private readonly sweepIntervalMs: number
  private readonly nowFn: () => number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: ChannelQueueLRUOpts = {}) {
    this.maxIdleMs = opts.maxIdleMs ?? 60 * 60 * 1000 // 1h
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60 * 1000 // 5min
    this.nowFn = opts.nowFn ?? (() => Date.now())
  }

  /**
   * Returns the current tail Promise for `channelId`, or Promise.resolve()
   * if absent. Does NOT store a placeholder (caller is expected to follow up
   * with setTail once the new tail is constructed).
   */
  getOrInitTail(channelId: string): Promise<void> {
    const entry = this.entries.get(channelId)
    return entry ? entry.tail : Promise.resolve()
  }

  /**
   * Sets the tail Promise for `channelId` and refreshes lastTouched to now().
   * Used both for fresh enqueues and for chaining subsequent turns.
   */
  setTail(channelId: string, tail: Promise<void>): void {
    this.entries.set(channelId, { tail, lastTouched: this.nowFn() })
  }

  /**
   * Removes the entry for `channelId` only when its stored tail === expected.
   * Matches the CAS-style cleanup in runner.ts / turn-queue.ts:
   * `if (channelQueues.get(channelId) === next) channelQueues.delete(channelId)`.
   * A no-op when the stored tail has already advanced to a newer turn.
   */
  deleteIfMatches(channelId: string, expected: Promise<void>): void {
    const entry = this.entries.get(channelId)
    if (entry && entry.tail === expected) {
      this.entries.delete(channelId)
    }
  }

  /** Snapshot of all current tails for drainAllTurns(). */
  values(): Iterable<Promise<void>> {
    const arr: Promise<void>[] = []
    for (const entry of this.entries.values()) arr.push(entry.tail)
    return arr
  }

  /** Current entry count. Stable across getOrInitTail/setTail/deleteIfMatches calls. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Manual eviction pass — removes entries whose lastTouched is older than
   * now() - maxIdleMs. Returns the count evicted (for observability /
   * optional audit emission deferred per 65-CONTEXT.md).
   */
  sweep(): number {
    const cutoff = this.nowFn() - this.maxIdleMs
    let evicted = 0
    for (const [channelId, entry] of this.entries) {
      if (entry.lastTouched < cutoff) {
        this.entries.delete(channelId)
        evicted++
      }
    }
    return evicted
  }

  /** Starts the automatic sweep interval. Idempotent — re-entering is safe. */
  startSweep(): void {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs)
    // unref(): don't prevent the process from exiting when all real work is done.
    // This allows bun test to exit cleanly even when the sweep interval is
    // still pending — the sweep fires opportunistically if the process stays alive.
    if (typeof this.sweepTimer === 'object' && this.sweepTimer !== null && 'unref' in this.sweepTimer) {
      (this.sweepTimer as { unref(): void }).unref()
    }
  }

  /** Stops the automatic sweep interval. Idempotent. */
  stopSweep(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * Removes all entries. Intended for test isolation only — clears accumulated
   * per-channel tails so module-level state doesn't bleed between test files.
   */
  clear(): void {
    this.entries.clear()
  }
}
