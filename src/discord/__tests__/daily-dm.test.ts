/**
 * Phase 35-03 (TOKEN-05): Tests for daily-dm module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setSystemTime as bunSetSystemTime } from 'bun:test'
import type { UsageRecord } from '../usage-store.js'

// Bun's vitest shim does not implement vi.setSystemTime; fall back to bun:test's
// setSystemTime which has identical semantics.
vi.setSystemTime = bunSetSystemTime as unknown as typeof vi.setSystemTime

// Mock usage-store so loadUsageRecords doesn't do real file I/O in scheduler tests
vi.mock('../usage-store.js', async () => {
  // Import just the types — usage-store is a leaf module with no circular deps
  return {
    loadUsageRecords: vi.fn().mockResolvedValue([]),
    appendUsage: vi.fn().mockResolvedValue(undefined),
    parseUsageLine: vi.fn().mockReturnValue(null),
    usageDir: vi.fn().mockReturnValue('/tmp/usage'),
    usagePath: vi.fn().mockReturnValue('/tmp/usage/2024-01-01.jsonl'),
  }
})

// ---------------------------------------------------------------------------
// Tests for msUntilNextFire
// ---------------------------------------------------------------------------

describe('msUntilNextFire', () => {
  it('returns correct ms when target hour is in the future today', async () => {
    const { msUntilNextFire } = await import('../daily-dm.js')
    // 06:00 UTC, target 07:00 UTC → 1 hour = 3,600,000 ms
    const now = new Date('2024-01-01T06:00:00.000Z')
    expect(msUntilNextFire(7, now)).toBe(3_600_000)
  })

  it('returns next-day ms when target hour is in the past today', async () => {
    const { msUntilNextFire } = await import('../daily-dm.js')
    // 08:00 UTC, target 07:00 UTC → 23 hours = 82,800,000 ms
    const now = new Date('2024-01-01T08:00:00.000Z')
    expect(msUntilNextFire(7, now)).toBe(23 * 3_600_000)
  })

  it('returns exactly 24 hours when already at target hour', async () => {
    const { msUntilNextFire } = await import('../daily-dm.js')
    // 07:00:00 UTC exactly, target 07:00 → diff=0 so returns 24h
    const now = new Date('2024-01-01T07:00:00.000Z')
    expect(msUntilNextFire(7, now)).toBe(24 * 3_600_000)
  })

  it('returns correct ms for midnight target', async () => {
    const { msUntilNextFire } = await import('../daily-dm.js')
    // 23:00 UTC, target 00:00 → 1 hour = 3,600,000 ms
    const now = new Date('2024-01-01T23:00:00.000Z')
    expect(msUntilNextFire(0, now)).toBe(3_600_000)
  })
})

// ---------------------------------------------------------------------------
// Tests for buildDailySummary
// ---------------------------------------------------------------------------

describe('buildDailySummary', () => {
  const SAMPLE_DATE = '2024-01-01'

  const makeRecord = (channelId: string, input: number, output: number): UsageRecord => ({
    ts: `${SAMPLE_DATE}T10:00:00.000Z`,
    channelId,
    userId: 'user123',
    model: 'gpt-4o',
    inputTokens: input,
    outputTokens: output,
  })

  it('returns fallback message for empty records', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    expect(buildDailySummary([], undefined, 'gpt-4o')).toBe('No usage recorded yesterday.')
  })

  it('includes total tokens in output', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const records: UsageRecord[] = [
      makeRecord('ch1', 100, 50),
      makeRecord('ch1', 200, 100),
    ]
    const result = buildDailySummary(records, undefined, 'gpt-4o')
    expect(result).toContain('300')  // total input
    expect(result).toContain('150')  // total output
    expect(result).toContain('Daily Usage Summary')
  })

  it('includes turn count', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const records: UsageRecord[] = [
      makeRecord('ch1', 100, 50),
      makeRecord('ch2', 200, 100),
      makeRecord('ch1', 50, 25),
    ]
    const result = buildDailySummary(records, undefined, 'gpt-4o')
    expect(result).toContain('3')  // 3 turns
    expect(result).toContain('Turns')
  })

  it('includes top channels section', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const records: UsageRecord[] = [
      makeRecord('ch1', 500, 250),
      makeRecord('ch2', 100, 50),
      makeRecord('ch1', 200, 100),
    ]
    const result = buildDailySummary(records, undefined, 'gpt-4o')
    expect(result).toContain('Top channels')
    expect(result).toContain('ch1')
    expect(result).toContain('ch2')
  })

  it('limits top channels to 5', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const channels = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ch7']
    const records: UsageRecord[] = channels.map((c, i) =>
      makeRecord(c, (7 - i) * 100, (7 - i) * 50)
    )
    const result = buildDailySummary(records, undefined, 'gpt-4o')
    // ch6 and ch7 are small — they should be cut off
    expect(result).not.toContain('ch6')
    expect(result).not.toContain('ch7')
  })

  it('includes estimated cost when pricing provided', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const records: UsageRecord[] = [makeRecord('ch1', 1_000_000, 1_000_000)]
    const pricing = { 'gpt-4o': { input: 2.5, output: 10.0 } }
    const result = buildDailySummary(records, pricing, 'gpt-4o')
    expect(result).toContain('$')
    expect(result).toContain('Est. cost')
  })

  it('sorts channels by total tokens descending', async () => {
    const { buildDailySummary } = await import('../daily-dm.js')
    const records: UsageRecord[] = [
      makeRecord('small', 10, 5),
      makeRecord('large', 1000, 500),
      makeRecord('medium', 100, 50),
    ]
    const result = buildDailySummary(records, undefined, 'gpt-4o')
    // 'large' should appear before 'medium' should appear before 'small'
    const idxLarge = result.indexOf('large')
    const idxMedium = result.indexOf('medium')
    const idxSmall = result.indexOf('small')
    expect(idxLarge).toBeLessThan(idxMedium)
    expect(idxMedium).toBeLessThan(idxSmall)
  })
})

// ---------------------------------------------------------------------------
// Tests for startDailyDmScheduler
// ---------------------------------------------------------------------------

// Skipped under bun:test: bun's vitest shim does not implement
// vi.useFakeTimers / vi.advanceTimersByTimeAsync, which these tests depend on.
// The msUntilNextFire pure-function tests above still cover the scheduling math.
describe.skip('startDailyDmScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('calls sendDm once after the first target hour is reached', async () => {
    const { startDailyDmScheduler, msUntilNextFire } = await import('../daily-dm.js')

    const sendDm = vi.fn().mockResolvedValue(undefined)
    const now = new Date('2024-01-01T06:00:00.000Z')
    vi.setSystemTime(now)

    const { stop } = startDailyDmScheduler({
      sendDm,
      ownerId: 'owner123',
      pricing: undefined,
      model: 'gpt-4o',
      targetHour: 7,
    })

    // Advance by slightly more than 1 hour (target is 07:00 UTC)
    await vi.advanceTimersByTimeAsync(msUntilNextFire(7, now) + 100)

    expect(sendDm).toHaveBeenCalledTimes(1)
    expect(sendDm).toHaveBeenCalledWith('owner123', expect.any(String))

    stop()
  })

  it('calls sendDm again after 24 more hours', async () => {
    const { startDailyDmScheduler, msUntilNextFire } = await import('../daily-dm.js')

    const sendDm = vi.fn().mockResolvedValue(undefined)
    const now = new Date('2024-01-01T06:00:00.000Z')
    vi.setSystemTime(now)

    const { stop } = startDailyDmScheduler({
      sendDm,
      ownerId: 'owner123',
      pricing: undefined,
      model: 'gpt-4o',
      targetHour: 7,
    })

    // First fire
    await vi.advanceTimersByTimeAsync(msUntilNextFire(7, now) + 100)
    expect(sendDm).toHaveBeenCalledTimes(1)

    // Second fire (24 hours later)
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(sendDm).toHaveBeenCalledTimes(2)

    stop()
  })

  it('stop() prevents further DM sends', async () => {
    const { startDailyDmScheduler, msUntilNextFire } = await import('../daily-dm.js')

    const sendDm = vi.fn().mockResolvedValue(undefined)
    const now = new Date('2024-01-01T06:00:00.000Z')
    vi.setSystemTime(now)

    const { stop } = startDailyDmScheduler({
      sendDm,
      ownerId: 'owner123',
      pricing: undefined,
      model: 'gpt-4o',
      targetHour: 7,
    })

    // Stop before it fires
    stop()

    // Advance past the fire time
    await vi.advanceTimersByTimeAsync(msUntilNextFire(7, now) + 100)
    expect(sendDm).not.toHaveBeenCalled()
  })
})
