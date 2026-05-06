import { describe, test, expect, beforeEach } from 'bun:test'
import * as state from './auto-dispatch-state.js'

describe('auto-dispatch-state — cooldown lifecycle (Phase 60 Task 1, DISPATCH-06)', () => {
  beforeEach(() => {
    state.__resetForTests()
  })

  test('registerOrchestrationComplete sets cooldown=2 → checkCooldown returns true', () => {
    state.registerOrchestrationComplete('ch1')
    expect(state.checkCooldown('ch1')).toBe(true)
  })

  test('one decrement leaves counter=1 → still in cooldown', () => {
    state.registerOrchestrationComplete('ch1')
    state.decrementCooldown('ch1')
    expect(state.checkCooldown('ch1')).toBe(true)
  })

  test('two decrements leave counter=0 → cooldown expires', () => {
    state.registerOrchestrationComplete('ch1')
    state.decrementCooldown('ch1')
    state.decrementCooldown('ch1')
    expect(state.checkCooldown('ch1')).toBe(false)
  })

  test('decrementCooldown on unknown channel is a no-op (does not go negative)', () => {
    // No cooldown ever set — decrementing must not create negative values
    state.decrementCooldown('never-seen')
    state.decrementCooldown('never-seen')
    state.decrementCooldown('never-seen')
    expect(state.checkCooldown('never-seen')).toBe(false)
  })

  test('per-channel isolation: channel A cooldown set, channel B unaffected', () => {
    state.registerOrchestrationComplete('ch-a')
    expect(state.checkCooldown('ch-a')).toBe(true)
    expect(state.checkCooldown('ch-b')).toBe(false)
  })

  test('__resetForTests clears cooldown Map', () => {
    state.registerOrchestrationComplete('ch1')
    state.registerOrchestrationComplete('ch2')
    expect(state.checkCooldown('ch1')).toBe(true)
    expect(state.checkCooldown('ch2')).toBe(true)
    state.__resetForTests()
    expect(state.checkCooldown('ch1')).toBe(false)
    expect(state.checkCooldown('ch2')).toBe(false)
  })
})

describe('auto-dispatch-state — pending lifecycle (Phase 60 Task 2, DISPATCH-05/07)', () => {
  beforeEach(() => {
    state.__resetForTests()
  })

  test('tryResolveAutoDispatchCancel with "!cancel" → resolves cancel=true, returns true', () => {
    const calls: boolean[] = []
    state.setPendingAutoDispatch('ch1', (cancel) => { calls.push(cancel) }, 100)
    const consumed = state.tryResolveAutoDispatchCancel('ch1', '!cancel')
    expect(consumed).toBe(true)
    expect(calls).toEqual([true])
  })

  test('tryResolveAutoDispatchCancel with non-!cancel content → returns false, resolver not called (silent drop per D-05)', () => {
    let callCount = 0
    state.setPendingAutoDispatch('ch1', () => { callCount++ }, 100)
    const consumed = state.tryResolveAutoDispatchCancel('ch1', 'hello')
    expect(consumed).toBe(false)
    expect(callCount).toBe(0)
    // Pending record still in place for the timer to resolve later
    expect(state.hasPendingDispatch('ch1')).toBe(true)
  })

  test('timer fires after window → resolver called cancel=false (dispatch proceeds)', async () => {
    const calls: boolean[] = []
    state.setPendingAutoDispatch('ch1', (cancel) => { calls.push(cancel) }, 100)
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toEqual([false])
    expect(state.hasPendingDispatch('ch1')).toBe(false)
  })

  test('manual cancel clears timer (no double-resolve)', async () => {
    let calls = 0
    state.setPendingAutoDispatch('ch1', () => { calls++ }, 100)
    expect(state.tryResolveAutoDispatchCancel('ch1', '!cancel')).toBe(true)
    // Wait past the original timer — if clearTimeout did not fire we would
    // see calls === 2 (manual + timer).
    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toBe(1)
  })

  test('per-channel isolation: cancel on a different channel does not resolve channel A', () => {
    const callsA: boolean[] = []
    state.setPendingAutoDispatch('ch-a', (cancel) => { callsA.push(cancel) }, 100)
    const consumed = state.tryResolveAutoDispatchCancel('ch-b', '!cancel')
    expect(consumed).toBe(false)
    expect(callsA).toEqual([])
    expect(state.hasPendingDispatch('ch-a')).toBe(true)
  })

  test('case-insensitive + trim: "  !CANCEL  " resolves cancel=true (D-07)', () => {
    const calls: boolean[] = []
    state.setPendingAutoDispatch('ch1', (cancel) => { calls.push(cancel) }, 100)
    const consumed = state.tryResolveAutoDispatchCancel('ch1', '  !CANCEL  ')
    expect(consumed).toBe(true)
    expect(calls).toEqual([true])
  })

  test('loose match rejected: "cancel" (no bang) returns false (D-07 exact-match)', () => {
    let callCount = 0
    state.setPendingAutoDispatch('ch1', () => { callCount++ }, 100)
    const consumed = state.tryResolveAutoDispatchCancel('ch1', 'cancel')
    expect(consumed).toBe(false)
    expect(callCount).toBe(0)
  })

  test('clearAllPendingDispatches clears timers + Map (shutdown safety)', async () => {
    let callsA = 0
    let callsB = 0
    state.setPendingAutoDispatch('ch-a', () => { callsA++ }, 100)
    state.setPendingAutoDispatch('ch-b', () => { callsB++ }, 100)
    state.clearAllPendingDispatches()
    expect(state.hasPendingDispatch('ch-a')).toBe(false)
    expect(state.hasPendingDispatch('ch-b')).toBe(false)
    // Wait past the original window — timers must not fire resolvers again.
    await new Promise((r) => setTimeout(r, 150))
    // Each resolver fired exactly once (from clearAllPendingDispatches itself)
    expect(callsA).toBe(1)
    expect(callsB).toBe(1)
  })

  test('hasPendingDispatch reflects state transitions (set / resolve / timer)', async () => {
    expect(state.hasPendingDispatch('ch1')).toBe(false)
    state.setPendingAutoDispatch('ch1', () => {}, 100)
    expect(state.hasPendingDispatch('ch1')).toBe(true)
    state.tryResolveAutoDispatchCancel('ch1', '!cancel')
    expect(state.hasPendingDispatch('ch1')).toBe(false)
    // After timer fires (separate channel)
    state.setPendingAutoDispatch('ch2', () => {}, 50)
    expect(state.hasPendingDispatch('ch2')).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(state.hasPendingDispatch('ch2')).toBe(false)
  })
})
