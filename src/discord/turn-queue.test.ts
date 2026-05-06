/**
 * Phase 65 (HYG-01): Tests for turn-queue.ts — per-channel promise queue,
 * active-turn counter, drain sentinel, drainAllTurns timeout.
 *
 * channelQueues is module-scoped state so each test should await a small
 * flush window to ensure prior turns have cleared.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  enqueue,
  setDraining,
  hasPendingTurns,
  drainAllTurns,
  channelQueues,
} from './turn-queue.js'

// Small helper to let the event loop flush settled promises.
async function flush(): Promise<void> {
  await new Promise<void>(r => setTimeout(r, 10))
}

describe('turn-queue', () => {
  beforeEach(async () => {
    setDraining(false)
    // Flush any stragglers from earlier tests so activeTurns → 0
    await drainAllTurns(200)
    await flush()
  })

  it('enqueue serializes work for the same channelId', async () => {
    const order: string[] = []
    let resolve1!: () => void
    const block = new Promise<void>(r => { resolve1 = r })

    enqueue('ch-1', async () => {
      order.push('start-1')
      await block
      order.push('end-1')
    })
    enqueue('ch-1', async () => {
      order.push('start-2')
    })

    // task 2 should not have started yet — task 1 is blocked
    await flush()
    expect(order).toEqual(['start-1'])

    resolve1()
    await flush()
    await flush()
    expect(order).toEqual(['start-1', 'end-1', 'start-2'])
  })

  it('enqueue runs different channelIds concurrently', async () => {
    const events: string[] = []
    let resolveA!: () => void
    const blockA = new Promise<void>(r => { resolveA = r })

    enqueue('ch-A', async () => {
      events.push('A-start')
      await blockA
      events.push('A-end')
    })
    enqueue('ch-B', async () => {
      events.push('B-start')
      events.push('B-end')
    })

    await flush()
    // B should have completed while A was blocked
    expect(events.includes('B-end')).toBe(true)
    expect(events.includes('A-end')).toBe(false)

    resolveA()
    await flush()
    expect(events.includes('A-end')).toBe(true)
  })

  it('rejected work does not stall the channel — next turn still runs', async () => {
    const calls: string[] = []

    enqueue('ch-retry', async () => {
      calls.push('first')
      throw new Error('boom')
    })
    enqueue('ch-retry', async () => {
      calls.push('second')
    })

    await flush()
    await flush()
    expect(calls).toEqual(['first', 'second'])
  })

  it('setDraining(true) makes enqueue a silent no-op', async () => {
    let called = false
    setDraining(true)

    enqueue('ch-drain', async () => { called = true })

    await flush()
    expect(called).toBe(false)
    expect(hasPendingTurns()).toBe(false)
  })

  it('hasPendingTurns reflects in-flight state', async () => {
    let resolve!: () => void
    const block = new Promise<void>(r => { resolve = r })

    enqueue('ch-flight', async () => {
      await block
    })

    // Yield so the enqueue body starts — enqueue itself bumps activeTurns
    // synchronously, so hasPendingTurns is true immediately.
    expect(hasPendingTurns()).toBe(true)

    resolve()
    await flush()
    await flush()
    expect(hasPendingTurns()).toBe(false)
  })

  it('drainAllTurns resolves quickly when no turns are pending', async () => {
    const started = Date.now()
    await drainAllTurns(1000)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(200)
  })

  it('drainAllTurns waits for pending turns to settle', async () => {
    let resolve!: () => void
    const block = new Promise<void>(r => { resolve = r })
    enqueue('ch-drain-wait', async () => {
      await block
    })

    // Let the enqueue body start (it awaits `block`)
    await flush()
    // Start drain
    const drainPromise = drainAllTurns(5000)
    // Let the turn finish
    resolve()
    await drainPromise
    expect(hasPendingTurns()).toBe(false)
  })

  it('drainAllTurns resolves at timeout when a turn hangs forever', async () => {
    enqueue('ch-hang', async () => {
      // never resolves
      await new Promise<void>(() => {})
    })

    const started = Date.now()
    await drainAllTurns(100)  // 100ms timeout
    const elapsed = Date.now() - started
    // Should have been cut off at ~100ms, not waited forever
    expect(elapsed).toBeLessThan(400)
    // The hanging turn is still in the queue though
    expect(hasPendingTurns()).toBe(true)
  })

  it('channelQueues is exported as a live ChannelQueueLRU reference (HYG-02)', () => {
    // Post-65-02: channelQueues is a ChannelQueueLRU instance. The contract
    // is Map-like via the public interface (getOrInitTail/setTail/values)
    // rather than actual Map subclassing. We assert the surface the runner
    // uses so a future implementation swap stays observable.
    expect(typeof channelQueues.getOrInitTail).toBe('function')
    expect(typeof channelQueues.setTail).toBe('function')
    expect(typeof channelQueues.deleteIfMatches).toBe('function')
    expect(typeof channelQueues.values).toBe('function')
    expect(typeof channelQueues.size).toBe('number')
  })
})
