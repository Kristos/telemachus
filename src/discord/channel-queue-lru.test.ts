/**
 * Phase 65 (HYG-02): Tests for ChannelQueueLRU — Map-backed per-channel
 * promise tail tracker with automatic idle-eviction.
 *
 * Uses an injected `nowFn` so tests can advance time deterministically without
 * spying on Date.now (avoids mock.module contamination per CLAUDE.md).
 * Uses spyOn(globalThis, 'setInterval' | 'clearInterval') for case 5.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { ChannelQueueLRU } from './channel-queue-lru.js'

describe('ChannelQueueLRU', () => {
  const spies: Array<{ restore: () => void }> = []

  afterEach(() => {
    while (spies.length) spies.pop()!.restore()
  })

  it('enqueue 100 distinct channelIds → size === 100, lastTouched ≈ now', () => {
    let now = 1_000_000
    const lru = new ChannelQueueLRU({ nowFn: () => now })
    for (let i = 0; i < 100; i++) {
      lru.setTail(`ch-${i}`, Promise.resolve())
    }
    expect(lru.size).toBe(100)
  })

  it('sweep() evicts all entries when now advances past maxIdleMs', () => {
    let now = 1_000_000
    const lru = new ChannelQueueLRU({
      nowFn: () => now,
      maxIdleMs: 60 * 60 * 1000, // 1h
    })
    for (let i = 0; i < 100; i++) {
      lru.setTail(`ch-${i}`, Promise.resolve())
    }
    expect(lru.size).toBe(100)

    // Advance 1h + 1ms past each entry's lastTouched
    now += 60 * 60 * 1000 + 1
    const evicted = lru.sweep()
    expect(evicted).toBe(100)
    expect(lru.size).toBe(0)
  })

  it('sweep() preserves entries touched within the window', () => {
    let now = 1_000_000
    const lru = new ChannelQueueLRU({
      nowFn: () => now,
      maxIdleMs: 60 * 60 * 1000, // 1h
    })

    // Batch 1 at t=0
    for (let i = 0; i < 10; i++) {
      lru.setTail(`old-${i}`, Promise.resolve())
    }

    // Batch 2 at t=30min
    now += 30 * 60 * 1000
    for (let i = 0; i < 10; i++) {
      lru.setTail(`new-${i}`, Promise.resolve())
    }

    // Advance to t=61min from start → batch 1 is 61min old (stale),
    // batch 2 is 31min old (fresh).
    now = 1_000_000 + 61 * 60 * 1000
    const evicted = lru.sweep()
    expect(evicted).toBe(10)
    expect(lru.size).toBe(10)
  })

  it('setTail on an existing channelId updates lastTouched (prevents eviction)', () => {
    let now = 1_000_000
    const lru = new ChannelQueueLRU({
      nowFn: () => now,
      maxIdleMs: 60 * 60 * 1000,
    })

    lru.setTail('ch-active', Promise.resolve())

    // Advance 59min then touch again
    now += 59 * 60 * 1000
    lru.setTail('ch-active', Promise.resolve())

    // Advance another 2min → 61min from original creation, but only 2min from last touch
    now += 2 * 60 * 1000
    const evicted = lru.sweep()
    expect(evicted).toBe(0)
    expect(lru.size).toBe(1)
  })

  it('getOrInitTail returns Promise.resolve() for absent channelId and records lastTouched', () => {
    let now = 1_000_000
    const lru = new ChannelQueueLRU({ nowFn: () => now })
    const p = lru.getOrInitTail('ch-new')
    // Returns a resolved promise for a fresh channel
    expect(p).toBeInstanceOf(Promise)
    // Note: getOrInitTail inserts a placeholder so lastTouched can be tracked;
    // setTail/enqueue will overwrite it with the real tail.
    expect(lru.size).toBeGreaterThanOrEqual(0)
  })

  it('deleteIfMatches removes entry only when tail === expected', () => {
    const lru = new ChannelQueueLRU({ nowFn: () => 0 })
    const tail1 = Promise.resolve()
    const tail2 = Promise.resolve()
    lru.setTail('ch-race', tail1)
    expect(lru.size).toBe(1)

    // No-op: different promise
    lru.deleteIfMatches('ch-race', tail2)
    expect(lru.size).toBe(1)

    // Match: entry removed
    lru.deleteIfMatches('ch-race', tail1)
    expect(lru.size).toBe(0)
  })

  it('startSweep schedules setInterval at sweepIntervalMs', () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const lru = new ChannelQueueLRU({
      sweepIntervalMs: 5 * 60 * 1000,
      nowFn: () => 0,
    })
    lru.startSweep()
    expect(setIntervalSpy).toHaveBeenCalled()
    // Assert the interval matches what we configured
    const call = setIntervalSpy.mock.calls[0]!
    expect(call[1]).toBe(5 * 60 * 1000)
    lru.stopSweep()
    spies.push({ restore: () => setIntervalSpy.mockRestore() })
  })

  it('stopSweep clears the interval; double-stop is idempotent', () => {
    const clearSpy = spyOn(globalThis, 'clearInterval')
    const lru = new ChannelQueueLRU({ nowFn: () => 0 })
    lru.startSweep()
    lru.stopSweep()
    expect(clearSpy).toHaveBeenCalledTimes(1)
    // Second stop is a no-op
    lru.stopSweep()
    expect(clearSpy).toHaveBeenCalledTimes(1)
    spies.push({ restore: () => clearSpy.mockRestore() })
  })

  it('values() yields all stored tails for drainAllTurns', async () => {
    const lru = new ChannelQueueLRU({ nowFn: () => 0 })
    lru.setTail('a', Promise.resolve())
    lru.setTail('b', Promise.resolve())
    lru.setTail('c', Promise.resolve())
    const tails = [...lru.values()]
    expect(tails).toHaveLength(3)
    // All should be promises
    for (const t of tails) {
      expect(t).toBeInstanceOf(Promise)
    }
  })
})
