import { describe, it, expect } from 'bun:test'
import { shouldAutoCompact } from './context-threshold.js'

describe('shouldAutoCompact', () => {
  it('returns false well below threshold', () => {
    expect(shouldAutoCompact(0.5, 90)).toBe(false)
  })

  it('returns false just below threshold', () => {
    expect(shouldAutoCompact(0.89, 90)).toBe(false)
  })

  it('returns true exactly at threshold', () => {
    expect(shouldAutoCompact(0.9, 90)).toBe(true)
  })

  it('returns true at full context', () => {
    expect(shouldAutoCompact(1.0, 90)).toBe(true)
  })

  it('threshold 0 → always true', () => {
    expect(shouldAutoCompact(0, 0)).toBe(true)
    expect(shouldAutoCompact(0.5, 0)).toBe(true)
  })

  it('threshold 100 → only true at pct >= 1.0', () => {
    expect(shouldAutoCompact(0.99, 100)).toBe(false)
    expect(shouldAutoCompact(1.0, 100)).toBe(true)
  })

  it('threshold > 100 → never true', () => {
    expect(shouldAutoCompact(1.0, 101)).toBe(false)
    expect(shouldAutoCompact(0.5, 200)).toBe(false)
  })

  it('NaN pct → false', () => {
    expect(shouldAutoCompact(NaN, 90)).toBe(false)
  })

  it('negative pct → false', () => {
    expect(shouldAutoCompact(-0.1, 90)).toBe(false)
  })
})
