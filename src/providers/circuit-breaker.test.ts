import { describe, it, expect, beforeEach } from 'bun:test'
import {
  tryAcquire,
  recordSuccess,
  recordFailure,
  snapshot,
  getDetails,
  resetAll,
} from './circuit-breaker.js'

// Deterministic clock for all tests
let clock = 1_000_000
const now = () => clock
const advance = (ms: number) => { clock += ms }
const opts = { failureThreshold: 3, cooldownMs: 30_000, now }

beforeEach(() => {
  resetAll()
  clock = 1_000_000
})

describe('circuit-breaker state machine', () => {
  it('starts CLOSED — first request always sends', () => {
    expect(tryAcquire('p', opts)).toBe('send')
    expect(snapshot('p')).toBe('closed')
  })

  it('stays CLOSED across failures below threshold', () => {
    recordFailure('p', opts)
    recordFailure('p', opts)
    expect(snapshot('p')).toBe('closed')
    expect(tryAcquire('p', opts)).toBe('send')
  })

  it('opens after exactly `failureThreshold` consecutive failures', () => {
    recordFailure('p', opts)
    recordFailure('p', opts)
    expect(snapshot('p')).toBe('closed')

    const r = recordFailure('p', opts)
    expect(r.state).toBe('open')
    expect(r.justOpened).toBe(true)
    expect(snapshot('p')).toBe('open')
  })

  it('returns "skip" while OPEN and cooldown has not elapsed', () => {
    for (let i = 0; i < 3; i++) recordFailure('p', opts)
    expect(snapshot('p')).toBe('open')
    expect(tryAcquire('p', opts)).toBe('skip')

    advance(29_999)
    expect(tryAcquire('p', opts)).toBe('skip')
  })

  it('transitions to HALF_OPEN after cooldown — first caller gets the probe', () => {
    for (let i = 0; i < 3; i++) recordFailure('p', opts)
    advance(30_001)

    expect(tryAcquire('p', opts)).toBe('send')
    expect(snapshot('p')).toBe('half_open')

    // Second concurrent caller must skip while probe is in flight
    expect(tryAcquire('p', opts)).toBe('skip')
  })

  it('HALF_OPEN → CLOSED on probe success (fully self-heals)', () => {
    for (let i = 0; i < 3; i++) recordFailure('p', opts)
    advance(31_000)
    tryAcquire('p', opts)
    expect(snapshot('p')).toBe('half_open')

    recordSuccess('p')
    expect(snapshot('p')).toBe('closed')
    expect(getDetails('p').consecutiveFailures).toBe(0)
    expect(tryAcquire('p', opts)).toBe('send')
  })

  it('HALF_OPEN → OPEN on probe failure — restarts cooldown window', () => {
    for (let i = 0; i < 3; i++) recordFailure('p', opts)
    advance(31_000)
    tryAcquire('p', opts)
    expect(snapshot('p')).toBe('half_open')

    const r = recordFailure('p', opts)
    expect(r.state).toBe('open')
    expect(r.justOpened).toBe(true)

    // Cooldown restarts from this new failure
    advance(29_000)
    expect(tryAcquire('p', opts)).toBe('skip')

    advance(2_000) // total 31s from the probe failure
    expect(tryAcquire('p', opts)).toBe('send')
  })

  it('single success resets counters even when still CLOSED', () => {
    recordFailure('p', opts)
    recordFailure('p', opts)
    expect(getDetails('p').consecutiveFailures).toBe(2)

    recordSuccess('p')
    expect(getDetails('p').consecutiveFailures).toBe(0)

    // After reset, three more failures are needed to open
    recordFailure('p', opts)
    recordFailure('p', opts)
    expect(snapshot('p')).toBe('closed')
    recordFailure('p', opts)
    expect(snapshot('p')).toBe('open')
  })

  it('keeps per-provider state isolated', () => {
    for (let i = 0; i < 3; i++) recordFailure('primary', opts)
    expect(snapshot('primary')).toBe('open')
    expect(snapshot('fallback')).toBe('closed')
    expect(tryAcquire('fallback', opts)).toBe('send')
  })

  it('5-concurrent-subagent scenario: only first hits the closed→open path, rest skip', () => {
    // Simulate the 2026-04-14 incident: 5 concurrent callers all try primary.
    // Without the breaker, all 5 would timeout on a dead endpoint.
    //
    // Caller #1 sends → fails
    // Caller #2 sends → fails  (still closed at threshold=3)
    // Caller #3 sends → fails  (just opened)
    // Callers #4, #5 arrive after open: must skip.

    expect(tryAcquire('p', opts)).toBe('send')   // #1
    recordFailure('p', opts)

    expect(tryAcquire('p', opts)).toBe('send')   // #2
    recordFailure('p', opts)

    expect(tryAcquire('p', opts)).toBe('send')   // #3 (opens on fail)
    recordFailure('p', opts)

    expect(tryAcquire('p', opts)).toBe('skip')   // #4 — saved from hammering
    expect(tryAcquire('p', opts)).toBe('skip')   // #5 — saved from hammering
  })

  it('respects configurable failureThreshold', () => {
    const o = { failureThreshold: 1, cooldownMs: 30_000, now }
    recordFailure('p', o)
    expect(snapshot('p')).toBe('open')
  })

  it('respects configurable cooldownMs', () => {
    const o = { failureThreshold: 3, cooldownMs: 5_000, now }
    for (let i = 0; i < 3; i++) recordFailure('p', o)
    advance(4_999)
    expect(tryAcquire('p', o)).toBe('skip')
    advance(2)
    expect(tryAcquire('p', o)).toBe('send')
  })
})
