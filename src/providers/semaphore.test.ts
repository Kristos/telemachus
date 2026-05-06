import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { LLMSemaphore } from './semaphore.js'
import * as auditModule from '../security/audit.js'

// CRITICAL per CLAUDE.md: NO mock.module(). Use spyOn + afterEach restore.

describe('LLMSemaphore', () => {
  describe('Test 1: allows up to maxInflight concurrent holders', () => {
    test('first two resolve immediately, third waits until one releases', async () => {
      const sem = new LLMSemaphore({ max: 2 })

      const release1 = await sem.acquire('p1')
      const release2 = await sem.acquire('p2')

      expect(sem.activeCount()).toBe(2)
      expect(sem.queueDepth()).toBe(0)

      // Third acquire should queue up
      let thirdResolved = false
      const thirdPromise = sem.acquire('p3').then((rel) => {
        thirdResolved = true
        return rel
      })

      // Give the microtask queue a tick so thirdPromise can settle if it were immediate
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(thirdResolved).toBe(false)
      expect(sem.queueDepth()).toBe(1)

      // Release one slot
      release1()
      const release3 = await thirdPromise

      expect(thirdResolved).toBe(true)
      expect(sem.activeCount()).toBe(2)

      release2()
      release3()
    })
  })

  describe('Test 2: releases in FIFO order', () => {
    test('acquires are granted A → B → C in submission order', async () => {
      const sem = new LLMSemaphore({ max: 1 })
      const order: string[] = []

      const releaseA = await sem.acquire('A')

      // B and C queue up
      const promiseB = sem.acquire('B').then((rel) => { order.push('B'); return rel })
      const promiseC = sem.acquire('C').then((rel) => { order.push('C'); return rel })

      // Give queue a tick
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(order).toEqual([])

      // Release A — B should get the slot
      releaseA()
      const releaseB = await promiseB
      expect(order).toEqual(['B'])

      // Release B — C should get the slot
      releaseB()
      const releaseC = await promiseC
      expect(order).toEqual(['B', 'C'])

      releaseC()
    })
  })

  describe('Test 3: parallel 10 vs cap of 4 — observed concurrency never exceeds 4', () => {
    test('peak concurrent is <= 4 and all 10 tasks complete', async () => {
      const sem = new LLMSemaphore({ max: 4 })
      let active = 0
      let peakActive = 0

      const tasks = Array.from({ length: 10 }, async (_, i) => {
        const release = await sem.acquire(`provider-${i}`)
        active++
        peakActive = Math.max(peakActive, active)
        await new Promise<void>((r) => setTimeout(r, 10))
        active--
        release()
      })

      await Promise.all(tasks)

      expect(peakActive).toBeLessThanOrEqual(4)
      expect(active).toBe(0)
    })
  })

  describe('Test 4: release is idempotent + does not over-grant', () => {
    test('calling release twice does NOT increment available count twice', async () => {
      const sem = new LLMSemaphore({ max: 1 })

      const releaseA = await sem.acquire('p1')

      // Queue up B
      let bResolved = false
      const promiseB = sem.acquire('p2').then((rel) => { bResolved = true; return rel })

      await new Promise<void>((r) => setTimeout(r, 0))
      expect(bResolved).toBe(false)

      // Release A once — B should get the slot
      releaseA()
      const releaseB = await promiseB
      expect(bResolved).toBe(true)
      expect(sem.activeCount()).toBe(1)

      // Call release A again — should be no-op
      releaseA()

      // Active count must still be 1 (B holds the slot), not 0 (double-release would cause that)
      expect(sem.activeCount()).toBe(1)

      releaseB()
      expect(sem.activeCount()).toBe(0)
    })
  })

  describe('Test 5: emits provider_queue_wait audit when waitMs > 500', () => {
    test('fires appendAuditEntry with correct fields when wait exceeds threshold', async () => {
      let fakeNow = 1000
      const sem = new LLMSemaphore({ max: 1, now: () => fakeNow })

      const spy = spyOn(auditModule, 'appendAuditEntry').mockResolvedValue(undefined)

      const releaseA = await sem.acquire('p1')

      // Start second acquire at fakeNow=1000
      const promiseB = sem.acquire('stub')

      await new Promise<void>((r) => setTimeout(r, 0))

      // Advance clock by 600ms before releasing A
      fakeNow = 1600

      releaseA()
      const releaseB = await promiseB

      // Should have fired the audit event
      expect(spy).toHaveBeenCalledTimes(1)
      const call = spy.mock.calls[0]![0]
      expect(call.kind).toBe('provider_queue_wait')
      expect((call as any).waitMs).toBeGreaterThanOrEqual(500)
      expect((call as any).providerName).toBe('stub')

      releaseB()
      spy.mockRestore()
    })
  })

  describe('Test 6: does NOT emit audit when waitMs <= 500', () => {
    test('does not fire appendAuditEntry when wait is under threshold', async () => {
      let fakeNow = 1000
      const sem = new LLMSemaphore({ max: 1, now: () => fakeNow })

      const spy = spyOn(auditModule, 'appendAuditEntry').mockResolvedValue(undefined)

      const releaseA = await sem.acquire('p1')

      const promiseB = sem.acquire('stub')

      await new Promise<void>((r) => setTimeout(r, 0))

      // Advance clock by only 200ms
      fakeNow = 1200

      releaseA()
      const releaseB = await promiseB

      const queueWaitCalls = spy.mock.calls.filter(
        (c) => (c[0] as any).kind === 'provider_queue_wait',
      )
      expect(queueWaitCalls.length).toBe(0)

      releaseB()
      spy.mockRestore()
    })
  })

  describe('Test 7: acquire(providerName) passes providerName to audit event', () => {
    test('providerName in audit entry matches the string passed to acquire()', async () => {
      let fakeNow = 1000
      const sem = new LLMSemaphore({ max: 1, now: () => fakeNow })

      const spy = spyOn(auditModule, 'appendAuditEntry').mockResolvedValue(undefined)

      const releaseA = await sem.acquire('any')
      const promiseB = sem.acquire('my-special-provider')

      await new Promise<void>((r) => setTimeout(r, 0))

      fakeNow = 2000 // 1000ms elapsed — above threshold

      releaseA()
      const releaseB = await promiseB

      expect(spy).toHaveBeenCalledTimes(1)
      const call = spy.mock.calls[0]![0]
      expect((call as any).providerName).toBe('my-special-provider')

      releaseB()
      spy.mockRestore()
    })
  })
})
