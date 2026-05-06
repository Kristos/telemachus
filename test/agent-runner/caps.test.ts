import { describe, test, expect } from 'bun:test'
import { checkCaps, type Caps, type CapsState } from '../../src/agent-runner/caps.js'

const s = (over: Partial<CapsState> = {}): CapsState => ({
  iterations: 0,
  startedAt: 1000,
  totalTokens: 0,
  now: 1000,
  ...over,
})

describe('checkCaps (Phase 22-01)', () => {
  test('returns null when no caps set', () => {
    expect(checkCaps(s({ iterations: 100, totalTokens: 999999, now: 1_000_000 }), {})).toBeNull()
  })

  test('returns null when under all limits', () => {
    expect(
      checkCaps(s({ iterations: 2, totalTokens: 50, now: 1500 }), {
        maxIterations: 10,
        maxWallClockMs: 5000,
        maxTotalTokens: 1000,
      }),
    ).toBeNull()
  })

  test('exactly at iterations limit triggers max_iterations', () => {
    expect(checkCaps(s({ iterations: 5 }), { maxIterations: 5 })).toBe('max_iterations')
  })

  test('exactly at wall clock limit triggers max_wall_clock', () => {
    expect(
      checkCaps(s({ startedAt: 1000, now: 6000 }), { maxWallClockMs: 5000 }),
    ).toBe('max_wall_clock')
  })

  test('exactly at tokens limit triggers max_total_tokens', () => {
    expect(
      checkCaps(s({ totalTokens: 1000 }), { maxTotalTokens: 1000 }),
    ).toBe('max_total_tokens')
  })

  test('iterations wins when all three trip', () => {
    expect(
      checkCaps(s({ iterations: 10, startedAt: 0, now: 10_000, totalTokens: 999 }), {
        maxIterations: 5,
        maxWallClockMs: 1000,
        maxTotalTokens: 100,
      }),
    ).toBe('max_iterations')
  })

  test('wall clock wins over tokens when iterations ok', () => {
    expect(
      checkCaps(s({ iterations: 1, startedAt: 0, now: 10_000, totalTokens: 999 }), {
        maxIterations: 100,
        maxWallClockMs: 1000,
        maxTotalTokens: 100,
      }),
    ).toBe('max_wall_clock')
  })

  test('only iterations cap set, others infinite', () => {
    expect(
      checkCaps(s({ iterations: 3, totalTokens: Number.MAX_SAFE_INTEGER }), { maxIterations: 3 }),
    ).toBe('max_iterations')
  })

  test('only tokens cap set', () => {
    expect(
      checkCaps(s({ totalTokens: 500 }), { maxTotalTokens: 499 }),
    ).toBe('max_total_tokens')
  })

  test('zero iterations with no caps = null', () => {
    expect(checkCaps(s(), {})).toBeNull()
  })

  test('zero-value cap treated as immediate trigger', () => {
    expect(checkCaps(s({ iterations: 0 }), { maxIterations: 0 })).toBe('max_iterations')
  })

  test('defaults to Date.now when CapsState.now omitted', () => {
    const startedAt = Date.now() - 10_000
    expect(
      checkCaps({ iterations: 0, startedAt, totalTokens: 0 }, { maxWallClockMs: 5000 }),
    ).toBe('max_wall_clock')
  })
})
