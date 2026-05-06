/**
 * Phase 35 (TOKEN-01, TOKEN-02): Tests for Discord usage store.
 *
 * Tests validate:
 *   - appendUsage writes date-partitioned JSONL to discord-usage dir
 *   - loadUsageRecords reads back written records sorted by timestamp
 *   - loadUsageRecords returns [] for missing date files
 *   - parseUsageLine returns null for malformed JSON
 *   - parseUsageLine returns null for records missing required fields
 *
 * process.env.HOME is overridden in each test to redirect writes to a
 * temp directory — same pattern as audit.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendUsage,
  loadUsageRecords,
  parseUsageLine,
  type UsageRecord,
} from '../usage-store.js'

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: new Date().toISOString(),
    channelId: 'chan-123',
    userId: 'user-456',
    model: 'glm-4-flash',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  }
}

describe('appendUsage', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'kc-usage-test-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  test('writes a valid JSONL line to date-partitioned file', async () => {
    const record = makeRecord({ ts: '2026-04-13T10:00:00.000Z' })
    await appendUsage(record)

    const file = join(tmpHome, '.telemachus', 'discord-usage', '2026-04-13.jsonl')
    expect(existsSync(file)).toBe(true)
    const line = readFileSync(file, 'utf8').trim()
    const parsed = JSON.parse(line) as UsageRecord
    expect(parsed.channelId).toBe('chan-123')
    expect(parsed.userId).toBe('user-456')
    expect(parsed.model).toBe('glm-4-flash')
    expect(parsed.inputTokens).toBe(100)
    expect(parsed.outputTokens).toBe(50)
  })

  test('appends multiple records on separate lines', async () => {
    const r1 = makeRecord({ ts: '2026-04-13T10:00:00.000Z', channelId: 'chan-1' })
    const r2 = makeRecord({ ts: '2026-04-13T11:00:00.000Z', channelId: 'chan-2' })
    await appendUsage(r1)
    await appendUsage(r2)

    const file = join(tmpHome, '.telemachus', 'discord-usage', '2026-04-13.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0]) as UsageRecord).channelId).toBe('chan-1')
    expect((JSON.parse(lines[1]) as UsageRecord).channelId).toBe('chan-2')
  })

  test('creates directory when it does not exist', async () => {
    const record = makeRecord({ ts: '2026-04-13T12:00:00.000Z' })
    // tmpHome is fresh — no .telemachus dir exists yet
    await appendUsage(record)
    const dir = join(tmpHome, '.telemachus', 'discord-usage')
    expect(existsSync(dir)).toBe(true)
  })
})

describe('loadUsageRecords', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'kc-usage-test-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  test('returns [] when no files exist in date range', async () => {
    const from = new Date('2026-04-10')
    const to = new Date('2026-04-12')
    const records = await loadUsageRecords(from, to)
    expect(records).toEqual([])
  })

  test('reads back records written by appendUsage', async () => {
    const r1 = makeRecord({ ts: '2026-04-13T09:00:00.000Z', channelId: 'c1' })
    const r2 = makeRecord({ ts: '2026-04-13T10:00:00.000Z', channelId: 'c2' })
    await appendUsage(r1)
    await appendUsage(r2)

    const from = new Date('2026-04-13')
    const to = new Date('2026-04-13')
    const records = await loadUsageRecords(from, to)
    expect(records).toHaveLength(2)
    expect(records[0].channelId).toBe('c1')
    expect(records[1].channelId).toBe('c2')
  })

  test('returns records sorted by timestamp ascending', async () => {
    const r1 = makeRecord({ ts: '2026-04-13T12:00:00.000Z' })
    const r2 = makeRecord({ ts: '2026-04-13T08:00:00.000Z' })
    // Append in reverse order to verify sorting
    await appendUsage(r1)
    await appendUsage(r2)

    const records = await loadUsageRecords(new Date('2026-04-13'), new Date('2026-04-13'))
    expect(records[0].ts).toBe('2026-04-13T08:00:00.000Z')
    expect(records[1].ts).toBe('2026-04-13T12:00:00.000Z')
  })

  test('spans multiple date files', async () => {
    const r1 = makeRecord({ ts: '2026-04-11T10:00:00.000Z', channelId: 'day1' })
    const r2 = makeRecord({ ts: '2026-04-12T10:00:00.000Z', channelId: 'day2' })
    await appendUsage(r1)
    await appendUsage(r2)

    const records = await loadUsageRecords(new Date('2026-04-11'), new Date('2026-04-12'))
    expect(records).toHaveLength(2)
    expect(records.map(r => r.channelId)).toContain('day1')
    expect(records.map(r => r.channelId)).toContain('day2')
  })

  test('skips malformed JSONL lines silently', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = join(tmpHome, '.telemachus', 'discord-usage')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '2026-04-13.jsonl')
    const goodRecord = makeRecord({ ts: '2026-04-13T10:00:00.000Z' })
    writeFileSync(file, `{broken json\n${JSON.stringify(goodRecord)}\n`, 'utf8')

    const records = await loadUsageRecords(new Date('2026-04-13'), new Date('2026-04-13'))
    expect(records).toHaveLength(1)
    expect(records[0].channelId).toBe('chan-123')
  })
})

describe('parseUsageLine', () => {
  test('parses a valid JSON line', () => {
    const record = makeRecord()
    const result = parseUsageLine(JSON.stringify(record))
    expect(result).not.toBeNull()
    expect(result!.channelId).toBe('chan-123')
    expect(result!.inputTokens).toBe(100)
  })

  test('returns null for malformed JSON', () => {
    expect(parseUsageLine('{not json')).toBeNull()
    expect(parseUsageLine('')).toBeNull()
    expect(parseUsageLine('null')).toBeNull()
  })

  test('returns null when required fields are missing', () => {
    // Missing channelId
    const partial = { ts: '2026-04-13T10:00:00Z', userId: 'u1', model: 'gpt', inputTokens: 1, outputTokens: 1 }
    expect(parseUsageLine(JSON.stringify(partial))).toBeNull()

    // Missing inputTokens
    const noInput = { ts: '2026-04-13T10:00:00Z', channelId: 'c', userId: 'u', model: 'm', outputTokens: 1 }
    expect(parseUsageLine(JSON.stringify(noInput))).toBeNull()
  })
})
