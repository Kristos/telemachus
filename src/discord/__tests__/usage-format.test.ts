/**
 * Phase 35-02 (TOKEN-03): Tests for usage-format module.
 * RED phase — usage-format.ts does not exist yet.
 */
import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../usage-store.js'
import {
  aggregateUsage,
  estimateCost,
  formatUsageTable,
  formatDiscordUsage,
  type AggregatedUsage,
} from '../usage-format.js'

const sampleRecords: UsageRecord[] = [
  {
    ts: '2026-04-13T08:00:00.000Z',
    channelId: '111',
    userId: 'user1',
    model: 'glm-4-flash',
    inputTokens: 1000,
    outputTokens: 500,
  },
  {
    ts: '2026-04-13T09:00:00.000Z',
    channelId: '222',
    userId: 'user1',
    model: 'glm-4-flash',
    inputTokens: 2000,
    outputTokens: 800,
  },
  {
    ts: '2026-04-12T10:00:00.000Z',
    channelId: '111',
    userId: 'user1',
    model: 'glm-4-flash',
    inputTokens: 500,
    outputTokens: 200,
  },
]

describe('aggregateUsage', () => {
  it('returns zero totals for empty array', () => {
    const agg = aggregateUsage([])
    expect(agg.totalInput).toBe(0)
    expect(agg.totalOutput).toBe(0)
    expect(agg.totalTurns).toBe(0)
    expect(agg.byDay.size).toBe(0)
    expect(agg.byChannel.size).toBe(0)
  })

  it('sums totalInput, totalOutput, totalTurns across all records', () => {
    const agg = aggregateUsage(sampleRecords)
    expect(agg.totalInput).toBe(3500)
    expect(agg.totalOutput).toBe(1500)
    expect(agg.totalTurns).toBe(3)
  })

  it('groups byDay using ts.slice(0,10)', () => {
    const agg = aggregateUsage(sampleRecords)
    expect(agg.byDay.has('2026-04-13')).toBe(true)
    expect(agg.byDay.has('2026-04-12')).toBe(true)
    expect(agg.byDay.size).toBe(2)

    const day13 = agg.byDay.get('2026-04-13')!
    expect(day13.input).toBe(3000)
    expect(day13.output).toBe(1300)
    expect(day13.turns).toBe(2)

    const day12 = agg.byDay.get('2026-04-12')!
    expect(day12.input).toBe(500)
    expect(day12.output).toBe(200)
    expect(day12.turns).toBe(1)
  })

  it('groups byChannel using channelId', () => {
    const agg = aggregateUsage(sampleRecords)
    expect(agg.byChannel.has('111')).toBe(true)
    expect(agg.byChannel.has('222')).toBe(true)

    const ch111 = agg.byChannel.get('111')!
    expect(ch111.input).toBe(1500)
    expect(ch111.output).toBe(700)
    expect(ch111.turns).toBe(2)
  })
})

describe('estimateCost', () => {
  const pricing = {
    'glm-4-flash': { input: 0.10, output: 0.30 },  // per 1M tokens
  }

  it('returns 0 when pricing is undefined', () => {
    expect(estimateCost(1000, 500, undefined, 'glm-4-flash')).toBe(0)
  })

  it('returns 0 when model is not in pricing map', () => {
    expect(estimateCost(1000, 500, pricing, 'unknown-model')).toBe(0)
  })

  it('calculates cost correctly for known model', () => {
    // 1000 input * 0.10/1M + 500 output * 0.30/1M
    // = 0.0001 + 0.00015 = 0.00025
    const cost = estimateCost(1000, 500, pricing, 'glm-4-flash')
    expect(cost).toBeCloseTo(0.00025, 8)
  })

  it('returns 0 for zero tokens', () => {
    expect(estimateCost(0, 0, pricing, 'glm-4-flash')).toBe(0)
  })
})

describe('formatUsageTable', () => {
  const pricing = {
    'glm-4-flash': { input: 0.10, output: 0.30 },
  }

  it('contains Token Usage Summary header', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('Token Usage Summary')
  })

  it('contains total token counts', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('3,500')  // totalInput formatted with commas
    expect(output).toContain('1,500')  // totalOutput formatted with commas
  })

  it('contains turn count', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('3')  // totalTurns
  })

  it('contains By Day section with date entries', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('By Day')
    expect(output).toContain('2026-04-13')
    expect(output).toContain('2026-04-12')
  })

  it('contains By Channel section', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('By Channel')
    expect(output).toContain('111')
    expect(output).toContain('222')
  })

  it('contains estimated cost', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, pricing, 'glm-4-flash')
    expect(output).toContain('Est. cost')
  })

  it('works with undefined pricing (no cost line or $0)', () => {
    const agg = aggregateUsage(sampleRecords)
    const output = formatUsageTable(agg, undefined, 'glm-4-flash')
    // Should not throw and should still show usage
    expect(output).toContain('Token Usage Summary')
  })
})

describe('formatDiscordUsage', () => {
  const pricing = {
    'glm-4-flash': { input: 0.10, output: 0.30 },
  }

  it('is compact (single-screen reply)', () => {
    const output = formatDiscordUsage(sampleRecords, pricing, 'glm-4-flash')
    // Discord messages have 2000 char limit; should be well under
    expect(output.length).toBeLessThan(500)
  })

  it('contains Today usage header or similar', () => {
    const output = formatDiscordUsage(sampleRecords, pricing, 'glm-4-flash')
    expect(output).toContain('Usage')
  })

  it('contains token counts', () => {
    const output = formatDiscordUsage(sampleRecords, pricing, 'glm-4-flash')
    // Total: 3500 in, 1500 out
    expect(output).toMatch(/3[,.]?500|3500/)
  })

  it('returns a short message for empty records', () => {
    const output = formatDiscordUsage([], pricing, 'glm-4-flash')
    expect(output).toBeTruthy()
    expect(output.length).toBeGreaterThan(0)
  })
})
