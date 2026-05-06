/**
 * Phase 59 (D-13, SC#5): Tests for formatBreakdown and --breakdown flag.
 *
 * Tests:
 *  1. formatBreakdown groups by routedTo and includes classifier overhead line
 *  2. Records without layerBreakdown.routedTo are grouped as "unrouted"
 *  3. Empty input returns "no turn summaries" message
 *  4. --breakdown flag detected by parseBreakdownFlag
 *  5. loadTurnSummaries reads JSONL and parses TurnSummaryRecords (integration)
 *
 * Phase 74: routedTo values updated from 'simple'/'complex' to IntentClass values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatBreakdown } from './usage-format.js'
import { parseBreakdownFlag, loadTurnSummaries } from './usage-cli.js'
import type { TurnSummaryRecord } from './turn-summary-store.js'

describe('formatBreakdown (SC#5, D-13)', () => {
  it('groups cost by routedTo and includes classifier-overhead line', () => {
    const records: TurnSummaryRecord[] = [
      {
        ts: '', turnId: 't1', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 100, totalOutputTokens: 50, totalCostUsd: 0.02,
        layerBreakdown: { routedTo: 'casual', classifierTokens: 8 },
      },
      {
        ts: '', turnId: 't2', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 500, totalOutputTokens: 200, totalCostUsd: 0.15,
        layerBreakdown: { routedTo: 'orchestration', classifierTokens: 6 },
      },
    ]
    const out = formatBreakdown(records)
    expect(out).toContain('casual: 1 turn')
    expect(out).toContain('$0.0200')
    expect(out).toContain('orchestration: 1 turn')
    expect(out).toContain('$0.1500')
    expect(out).toContain('Classifier overhead:')
    // Total classifier tokens = 14
    expect(out).toContain('14 tokens')
  })

  it('accumulates multiple records in the same routedTo group', () => {
    const records: TurnSummaryRecord[] = [
      {
        ts: '', turnId: 't1', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 100, totalOutputTokens: 50, totalCostUsd: 0.02,
        layerBreakdown: { routedTo: 'casual', classifierTokens: 8 },
      },
      {
        ts: '', turnId: 't2', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 200, totalOutputTokens: 100, totalCostUsd: 0.02,
        layerBreakdown: { routedTo: 'casual', classifierTokens: 7 },
      },
    ]
    const out = formatBreakdown(records)
    // Two casual turns accumulated together
    expect(out).toContain('casual: 2 turns')
    expect(out).toContain('$0.0400')
  })

  it('groups records without layerBreakdown.routedTo as "unrouted"', () => {
    const records: TurnSummaryRecord[] = [
      {
        ts: '', turnId: 't1', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 10, totalOutputTokens: 5, totalCostUsd: 0.01,
        // No layerBreakdown at all
      },
    ]
    const out = formatBreakdown(records)
    expect(out).toContain('unrouted')
  })

  it('returns "no turn summaries" for empty input', () => {
    const out = formatBreakdown([])
    expect(out).toContain('No turn summaries')
  })

  // Phase 64 (CACHE-04): cache columns for breakdown
  it('includes cache_read + cache_create columns when TurnSummaryRecords carry them', () => {
    const records: TurnSummaryRecord[] = [
      {
        ts: '', turnId: 't1', channelId: 'c', userId: 'u', model: 'claude-sonnet-4-5',
        totalInputTokens: 22, totalOutputTokens: 100, totalCostUsd: 0.001,
        totalCacheReadTokens: 1215, totalCacheCreationTokens: 0,
        layerBreakdown: { routedTo: 'orchestration', classifierTokens: 0 },
      },
      {
        ts: '', turnId: 't2', channelId: 'c', userId: 'u', model: 'claude-sonnet-4-5',
        totalInputTokens: 1215, totalOutputTokens: 50, totalCostUsd: 0.004,
        totalCacheReadTokens: 0, totalCacheCreationTokens: 1215,
        layerBreakdown: { routedTo: 'orchestration', classifierTokens: 0 },
      },
    ]
    const out = formatBreakdown(records)
    expect(out).toContain('orchestration: 2 turns')
    expect(out).toContain('1215 cache_read')
    expect(out).toContain('1215 cache_create')
  })

  it('omits cache columns entirely when no record has cache tokens (non-Anthropic baseline)', () => {
    const records: TurnSummaryRecord[] = [
      {
        ts: '', turnId: 't1', channelId: 'c', userId: 'u', model: 'glm-4.6',
        totalInputTokens: 100, totalOutputTokens: 50, totalCostUsd: 0.02,
        layerBreakdown: { routedTo: 'casual', classifierTokens: 8 },
      },
    ]
    const out = formatBreakdown(records)
    expect(out).not.toContain('cache_read')
    expect(out).not.toContain('cache_create')
  })
})

describe('parseBreakdownFlag', () => {
  it('returns true when --breakdown is in argv', () => {
    expect(parseBreakdownFlag(['--breakdown'])).toBe(true)
    expect(parseBreakdownFlag(['--week', '--breakdown'])).toBe(true)
    expect(parseBreakdownFlag(['--breakdown', '--date', '2026-04-18'])).toBe(true)
  })

  it('returns false when --breakdown is absent', () => {
    expect(parseBreakdownFlag([])).toBe(false)
    expect(parseBreakdownFlag(['--json', '--week'])).toBe(false)
    expect(parseBreakdownFlag(['--today'])).toBe(false)
  })
})

describe('loadTurnSummaries', () => {
  let origHome: string | undefined
  let tmpHome: string

  beforeEach(async () => {
    origHome = process.env.HOME
    tmpHome = await mkdtemp(join(tmpdir(), 'kc-ts-'))
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
  })

  it('reads turn-summary JSONL and returns parsed records', async () => {
    const date = '2026-04-18'
    const dir = join(tmpHome, '.telemachus', 'discord-turn-summaries')
    await mkdir(dir, { recursive: true })

    const record: TurnSummaryRecord = {
      ts: `${date}T10:00:00.000Z`,
      turnId: 't1',
      channelId: 'c123',
      userId: 'u456',
      model: 'glm-4.6',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCostUsd: 0.02,
      layerBreakdown: { routedTo: 'casual', classifierTokens: 8 },
    }
    await writeFile(join(dir, `${date}.jsonl`), JSON.stringify(record) + '\n')

    const from = new Date(`${date}T00:00:00.000Z`)
    const to = new Date(`${date}T23:59:59.999Z`)
    const records = await loadTurnSummaries(from, to)

    expect(records.length).toBe(1)
    expect(records[0]!.turnId).toBe('t1')
    expect(records[0]!.layerBreakdown?.routedTo).toBe('casual')
    expect(records[0]!.layerBreakdown?.classifierTokens).toBe(8)
  })

  it('returns [] when no files exist for the date range', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const to = new Date('2026-01-01T23:59:59.999Z')
    const records = await loadTurnSummaries(from, to)
    expect(records).toEqual([])
  })
})
