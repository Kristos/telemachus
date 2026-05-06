import { describe, it, expect } from 'bun:test'
import { acquireWorktreeLock, withWorktreeLock } from './git.js'

describe('worktree mutex', () => {
  it('acquireWorktreeLock serializes concurrent calls — second starts after first releases', async () => {
    const timestamps: { label: string; time: number }[] = []

    // Acquire the first lock
    const release1 = await acquireWorktreeLock()
    timestamps.push({ label: 'first-acquired', time: Date.now() })

    // Start acquiring second lock (should not resolve until first is released)
    let secondAcquiredTime = 0
    const secondPromise = acquireWorktreeLock().then((release2) => {
      secondAcquiredTime = Date.now()
      return release2
    })

    // Release the first lock after a small delay
    await new Promise((resolve) => setTimeout(resolve, 20))
    const firstReleasedTime = Date.now()
    release1()

    // Now second should resolve
    const release2 = await secondPromise
    release2()

    // Second must have been acquired AFTER first was released
    expect(secondAcquiredTime).toBeGreaterThanOrEqual(firstReleasedTime)
    timestamps.push({ label: 'first-released', time: firstReleasedTime })
    timestamps.push({ label: 'second-acquired', time: secondAcquiredTime })
  })

  it('withWorktreeLock runs operations sequentially', async () => {
    const order: number[] = []
    let counter = 0

    // Fire 3 concurrent withWorktreeLock calls — they must execute sequentially
    await Promise.all([
      withWorktreeLock(async () => {
        const myNum = ++counter
        order.push(myNum)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(-(myNum)) // push negative to mark completion
      }),
      withWorktreeLock(async () => {
        const myNum = ++counter
        order.push(myNum)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(-(myNum))
      }),
      withWorktreeLock(async () => {
        const myNum = ++counter
        order.push(myNum)
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push(-(myNum))
      }),
    ])

    // Each operation must complete (positive then negative) before the next starts
    // i.e. order must be: [1, -1, 2, -2, 3, -3] in some assignment of 1,2,3
    expect(order).toHaveLength(6)
    // Verify no interleaving: all positive numbers come in pairs with their completion
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBeGreaterThan(0) // start
      expect(order[i + 1]).toBeLessThan(0) // end
      expect(order[i]).toBe(-order[i + 1]) // same operation
    }
  })
})
