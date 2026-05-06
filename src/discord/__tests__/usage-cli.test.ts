/**
 * Phase 35-02 (TOKEN-03): Tests for usage-cli module.
 * RED phase — usage-cli.ts does not exist yet.
 * Tests the date range computation helper and flag parsing logic.
 */
import { describe, it, expect } from 'vitest'
import {
  parseDateRange,
  type DateRange,
} from '../usage-cli.js'

describe('parseDateRange', () => {
  it('defaults to today (--today) when no flags', () => {
    const range = parseDateRange([])
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    expect(range.from.toISOString().slice(0, 10)).toBe(todayStr)
    expect(range.to.toISOString().slice(0, 10)).toBe(todayStr)
  })

  it('--today returns today start and end of day', () => {
    const range = parseDateRange(['--today'])
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    expect(range.from.toISOString().slice(0, 10)).toBe(todayStr)
    expect(range.to.toISOString().slice(0, 10)).toBe(todayStr)
    // from should be start of day (00:00:00 UTC)
    expect(range.from.getUTCHours()).toBe(0)
    expect(range.from.getUTCMinutes()).toBe(0)
  })

  it('--week returns last 7 days', () => {
    const range = parseDateRange(['--week'])
    const now = new Date()
    const diffMs = now.getTime() - range.from.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(6)
    expect(diffDays).toBeLessThanOrEqual(8)
  })

  it('--month returns last 30 days', () => {
    const range = parseDateRange(['--month'])
    const now = new Date()
    const diffMs = now.getTime() - range.from.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(29)
    expect(diffDays).toBeLessThanOrEqual(31)
  })

  it('--all returns a very early start date', () => {
    const range = parseDateRange(['--all'])
    expect(range.from.getFullYear()).toBeLessThanOrEqual(2020)
  })

  it('--from YYYY-MM-DD sets explicit start', () => {
    const range = parseDateRange(['--from', '2026-04-01'])
    expect(range.from.toISOString().slice(0, 10)).toBe('2026-04-01')
  })

  it('--to YYYY-MM-DD sets explicit end', () => {
    const range = parseDateRange(['--to', '2026-04-10'])
    expect(range.to.toISOString().slice(0, 10)).toBe('2026-04-10')
  })

  it('--from and --to together set explicit range', () => {
    const range = parseDateRange(['--from', '2026-04-01', '--to', '2026-04-10'])
    expect(range.from.toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(range.to.toISOString().slice(0, 10)).toBe('2026-04-10')
  })

  it('--json flag does not affect date range', () => {
    const range = parseDateRange(['--today', '--json'])
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    expect(range.from.toISOString().slice(0, 10)).toBe(todayStr)
  })
})
