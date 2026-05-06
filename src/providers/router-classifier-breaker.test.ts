/**
 * Unit tests for RouterClassifierBreaker (COST-05, Phase 61).
 *
 * Uses injected `now` clock for deterministic state-machine verification.
 * No real timers, no spyOn on Date.now (avoids cross-test contamination).
 * Per CLAUDE.md: spyOn only — never mock.module. These tests don't need
 * spyOn at all since the clock is injected at construction time.
 */
import { describe, it, expect } from 'bun:test'
import { RouterClassifierBreaker } from './router-classifier-breaker.js'

function makeClock() {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

describe('RouterClassifierBreaker (COST-05, Phase 61)', () => {
  it('Test 1: fresh breaker is closed and tryAcquire returns "send"', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({ now: clock.now })
    expect(b.tryAcquire()).toBe('send')
    expect(b.snapshot().state).toBe('closed')
  })

  it('Test 2: 2 escalations stay closed; 3rd opens the circuit', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({ now: clock.now })
    expect(b.recordEscalation().transition).toBe('none')
    expect(b.snapshot().state).toBe('closed')

    clock.advance(1_000)
    expect(b.recordEscalation().transition).toBe('none')
    expect(b.snapshot().state).toBe('closed')

    clock.advance(1_000)
    expect(b.recordEscalation().transition).toBe('opened')
    expect(b.snapshot().state).toBe('open')
    expect(b.tryAcquire()).toBe('skip')
  })

  it('Test 3: rolling window — old escalations outside windowMs are pruned', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({ now: clock.now, windowMs: 60_000 })

    // Two escalations at t=0 and t=1s.
    expect(b.recordEscalation().transition).toBe('none')
    clock.advance(1_000)
    expect(b.recordEscalation().transition).toBe('none')

    // Skip ahead 70s — both previous escalations now outside the 60s window.
    clock.advance(70_000)
    // This escalation counts alone; threshold (3) not met.
    expect(b.recordEscalation().transition).toBe('none')
    expect(b.snapshot().state).toBe('closed')
  })

  it('Test 4: in open, before cooldownMs returns "skip"; after cooldown transitions to half_open', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({
      now: clock.now,
      initialCooldownMs: 10_000,
      failureThreshold: 1,
    })
    // Trip on first escalation.
    expect(b.recordEscalation().transition).toBe('opened')
    expect(b.tryAcquire()).toBe('skip')

    // Half-way through cooldown — still open.
    clock.advance(5_000)
    expect(b.tryAcquire()).toBe('skip')

    // Past cooldown — next tryAcquire transitions to half_open and returns send.
    clock.advance(5_500)
    expect(b.tryAcquire()).toBe('send')
    expect(b.snapshot().state).toBe('half_open')

    // Another tryAcquire during probe returns skip.
    expect(b.tryAcquire()).toBe('skip')
  })

  it('Test 5: half_open → recordSuccess closes circuit and clears counters', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({
      now: clock.now,
      initialCooldownMs: 1_000,
      failureThreshold: 1,
    })
    b.recordEscalation() // open
    clock.advance(2_000)
    expect(b.tryAcquire()).toBe('send') // half_open
    b.recordSuccess()
    expect(b.snapshot().state).toBe('closed')
    // And next tryAcquire still works because counters cleared.
    expect(b.tryAcquire()).toBe('send')
  })

  it('Test 6: half_open → recordEscalation reopens with doubled cooldown', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({
      now: clock.now,
      initialCooldownMs: 120_000,
      maxCooldownMs: 600_000,
      failureThreshold: 1,
    })
    b.recordEscalation() // open, cooldown=120_000
    expect(b.snapshot().cooldownMs).toBe(120_000)

    clock.advance(120_001)
    expect(b.tryAcquire()).toBe('send') // half_open probe
    const result = b.recordEscalation()
    expect(result.transition).toBe('stay_open')
    expect(b.snapshot().state).toBe('open')
    expect(b.snapshot().cooldownMs).toBe(240_000) // doubled
  })

  it('Test 7: exponential backoff caps at maxCooldownMs', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({
      now: clock.now,
      initialCooldownMs: 120_000,
      maxCooldownMs: 600_000,
      failureThreshold: 1,
    })
    b.recordEscalation() // open, 120k
    // Keep failing probes — cooldown should 120→240→480→600 (capped) regardless of further doubling.
    const trip = () => {
      clock.advance(b.snapshot().cooldownMs + 1)
      expect(b.tryAcquire()).toBe('send')
      b.recordEscalation()
    }
    trip() // 240k
    expect(b.snapshot().cooldownMs).toBe(240_000)
    trip() // 480k
    expect(b.snapshot().cooldownMs).toBe(480_000)
    trip() // would be 960k, capped to 600k
    expect(b.snapshot().cooldownMs).toBe(600_000)
    trip() // stays at 600k
    expect(b.snapshot().cooldownMs).toBe(600_000)
  })

  it('Test 8: recordSuccess in any state resets counters (self-heal)', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({ now: clock.now })
    b.recordEscalation()
    b.recordEscalation()
    // Before opening, success should reset the rolling window.
    b.recordSuccess()
    expect(b.snapshot().state).toBe('closed')
    // Now we need 3 more escalations to open the circuit — proves counters cleared.
    b.recordEscalation()
    b.recordEscalation()
    expect(b.snapshot().state).toBe('closed')
    expect(b.recordEscalation().transition).toBe('opened')
  })

  it('Test 9: custom options override defaults (failureThreshold=1, windowMs=10)', () => {
    const clock = makeClock()
    const b = new RouterClassifierBreaker({
      now: clock.now,
      failureThreshold: 1,
      windowMs: 10,
    })
    expect(b.recordEscalation().transition).toBe('opened')
    expect(b.snapshot().state).toBe('open')
  })
})
