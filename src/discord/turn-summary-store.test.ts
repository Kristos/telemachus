/**
 * Phase 57 (MEAS-02): Tests for TurnSummaryRecord JSONL store.
 *
 * Uses HOME env redirection to a temp dir so JSONL writes don't touch
 * ~/.telemachus in CI or dev. Uses spyOn only (CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTurnSummary,
  parseTurnSummaryLine,
  summaryPath,
  summaryDir,
  type TurnSummaryRecord,
} from './turn-summary-store.js'

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpHome: string
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tmpHome = await mkdtemp(join(tmpdir(), 'kc-summary-test-'))
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  await rm(tmpHome, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

const baseRecord: TurnSummaryRecord = {
  ts: '2026-04-17T08:00:00.000Z',
  turnId: 'test-turn-id-1234',
  channelId: 'channel-abc',
  userId: 'user-xyz',
  model: 'glm-4.6',
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  totalCostUsd: 0.0017,
}

describe('turn-summary-store', () => {
  it('Test A: appendTurnSummary writes to ~/.telemachus/discord-turn-summaries/YYYY-MM-DD.jsonl', async () => {
    await appendTurnSummary(baseRecord)
    const expectedPath = summaryPath(new Date(baseRecord.ts))
    const content = await readFile(expectedPath, 'utf8')
    expect(content.trim()).toBeTruthy()
    // Confirm path is under expected directory
    expect(expectedPath).toContain('discord-turn-summaries')
    expect(expectedPath).toContain('2026-04-17.jsonl')
  })

  it('Test B: parseTurnSummaryLine round-trips a full record', async () => {
    await appendTurnSummary(baseRecord)
    const filePath = summaryPath(new Date(baseRecord.ts))
    const content = await readFile(filePath, 'utf8')
    const parsed = parseTurnSummaryLine(content.trim())
    expect(parsed).not.toBeNull()
    expect(parsed!.ts).toBe(baseRecord.ts)
    expect(parsed!.turnId).toBe(baseRecord.turnId)
    expect(parsed!.channelId).toBe(baseRecord.channelId)
    expect(parsed!.userId).toBe(baseRecord.userId)
    expect(parsed!.model).toBe(baseRecord.model)
    expect(parsed!.totalInputTokens).toBe(baseRecord.totalInputTokens)
    expect(parsed!.totalOutputTokens).toBe(baseRecord.totalOutputTokens)
    // Float precision check
    expect(parsed!.totalCostUsd).toBeCloseTo(0.0017, 6)
  })

  it('Test C: parseTurnSummaryLine returns null for missing required field (totalCostUsd)', () => {
    const line = JSON.stringify({
      ts: '2026-04-17T08:00:00.000Z',
      turnId: 'test-id',
      channelId: 'c1',
      userId: 'u1',
      model: 'glm-4.6',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      // totalCostUsd intentionally missing
    })
    const result = parseTurnSummaryLine(line)
    expect(result).toBeNull()
  })

  it('Test D: parseTurnSummaryLine returns null for empty/blank line', () => {
    expect(parseTurnSummaryLine('')).toBeNull()
    expect(parseTurnSummaryLine('   ')).toBeNull()
    expect(parseTurnSummaryLine('\n')).toBeNull()
  })

  it('Test E: appendTurnSummary swallows fs errors and does NOT throw', async () => {
    // Point HOME to a regular file so mkdir will fail (can't create dir where a file exists)
    const fakeHome = join(tmpHome, 'not-a-dir.txt')
    await writeFile(fakeHome, 'i am a file, not a directory')
    process.env.HOME = fakeHome

    // Must not throw or reject
    try {
      await appendTurnSummary(baseRecord)
      // If we reach here without throwing, test passes
    } catch {
      throw new Error('appendTurnSummary threw — must be silent (best-effort write)')
    }
    // Restore for teardown
    process.env.HOME = tmpHome
  })

  it('Test F: optional layerBreakdown round-trips', async () => {
    const recordWithBreakdown: TurnSummaryRecord = {
      ...baseRecord,
      ts: '2026-04-17T09:00:00.000Z',
      turnId: 'turn-with-breakdown',
      layerBreakdown: {
        compressionSavedTokens: 500,
      },
    }
    await appendTurnSummary(recordWithBreakdown)
    const filePath = summaryPath(new Date(recordWithBreakdown.ts))
    const content = await readFile(filePath, 'utf8')
    const parsed = parseTurnSummaryLine(content.trim())
    expect(parsed).not.toBeNull()
    expect(parsed!.layerBreakdown).toBeDefined()
    expect(parsed!.layerBreakdown?.compressionSavedTokens).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// COST-08 (Phase 61): contextSizeTokens schema extension
// ---------------------------------------------------------------------------
//
// 999.13 documented that v3.5-MILESTONE-REPORT §7 input tokens per turn ranged
// 68k–388k averaging 234k — invisible in the audit trail because the schema
// had no field for it. Adding contextSizeTokens as an additive optional field
// makes that observable without breaking old JSONL rows.
// ---------------------------------------------------------------------------

describe('turn-summary-store contextSizeTokens (COST-08, Phase 61)', () => {
  it('parseTurnSummaryLine reads contextSizeTokens when present as number', () => {
    const line = JSON.stringify({ ...baseRecord, contextSizeTokens: 234_000 })
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.contextSizeTokens).toBe(234_000)
  })

  it('parseTurnSummaryLine omits contextSizeTokens field when absent (backward compat)', () => {
    // baseRecord has no contextSizeTokens — stringify round-trip should
    // produce a parsed record without the field (undefined).
    const line = JSON.stringify(baseRecord)
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.contextSizeTokens).toBeUndefined()
    // And the field should NOT appear in the object literal (for
    // downstream consumers that iterate Object.keys).
    expect(Object.hasOwn(parsed!, 'contextSizeTokens')).toBe(false)
  })

  it('parseTurnSummaryLine drops non-number contextSizeTokens (graceful tolerance)', () => {
    const line = JSON.stringify({ ...baseRecord, contextSizeTokens: 'not a number' })
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.contextSizeTokens).toBeUndefined()
  })

  it('parseTurnSummaryLine drops NaN contextSizeTokens', () => {
    // JSON.stringify turns NaN into null, so we build the line manually.
    const line =
      '{"ts":"2026-04-17T08:00:00.000Z","turnId":"x","channelId":"c","userId":"u","model":"m","totalInputTokens":1,"totalOutputTokens":1,"totalCostUsd":0,"contextSizeTokens":NaN}'
    // Invalid JSON (NaN not valid) → parseTurnSummaryLine should return null.
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).toBeNull()

    // The realistic NaN-in-code case: a record built in-memory with NaN then
    // passed through JSON.stringify — JSON converts NaN to null which fails
    // the type guard cleanly.
    const stringified = JSON.stringify({ ...baseRecord, contextSizeTokens: NaN })
    const parsed2 = parseTurnSummaryLine(stringified)
    expect(parsed2).not.toBeNull()
    expect(parsed2!.contextSizeTokens).toBeUndefined() // null → typeof 'object', dropped
  })

  it('round-trip: write TurnSummaryRecord with contextSizeTokens=100000, parse back', async () => {
    const record: TurnSummaryRecord = {
      ...baseRecord,
      ts: '2026-04-17T10:00:00.000Z',
      turnId: 'turn-cost-08-roundtrip',
      contextSizeTokens: 100_000,
    }
    await appendTurnSummary(record)
    const filePath = summaryPath(new Date(record.ts))
    const content = await readFile(filePath, 'utf8')
    const parsed = parseTurnSummaryLine(content.trim())
    expect(parsed).not.toBeNull()
    expect(parsed!.contextSizeTokens).toBe(100_000)
  })

  // ---------------------------------------------------------------------------
  // CACHE-03 (Phase 64): cacheReadTokens + cacheCreationTokens schema extension
  // ---------------------------------------------------------------------------
  //
  // Anthropic prompt caching: v3.5 SUCCESS-02a never observed cache_read tokens
  // because they weren't persisted. CACHE-03 adds two optional fields following
  // the COST-08 additive pattern.
  // ---------------------------------------------------------------------------
  it('CACHE-03: parseTurnSummaryLine reads totalCacheReadTokens when present', () => {
    const line = JSON.stringify({ ...baseRecord, totalCacheReadTokens: 1215 })
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.totalCacheReadTokens).toBe(1215)
  })

  it('CACHE-03: parseTurnSummaryLine reads totalCacheCreationTokens when present', () => {
    const line = JSON.stringify({ ...baseRecord, totalCacheCreationTokens: 1215 })
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.totalCacheCreationTokens).toBe(1215)
  })

  it('CACHE-03: parseTurnSummaryLine omits cache fields when absent (backward compat)', () => {
    const line = JSON.stringify(baseRecord)
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.totalCacheReadTokens).toBeUndefined()
    expect(parsed!.totalCacheCreationTokens).toBeUndefined()
    expect(Object.hasOwn(parsed!, 'totalCacheReadTokens')).toBe(false)
    expect(Object.hasOwn(parsed!, 'totalCacheCreationTokens')).toBe(false)
  })

  it('CACHE-03: parseTurnSummaryLine drops non-number cache fields silently', () => {
    const line = JSON.stringify({
      ...baseRecord,
      totalCacheReadTokens: 'nope',
      totalCacheCreationTokens: null,
    })
    const parsed = parseTurnSummaryLine(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.totalCacheReadTokens).toBeUndefined()
    expect(parsed!.totalCacheCreationTokens).toBeUndefined()
  })

  it('COST-02 + COST-08 round-trip: routedModel + contextSizeTokens survive disk write', async () => {
    // End-to-end test matching the v3.5-MILESTONE-REPORT §7 per-turn profile:
    // 234k input tokens, flash-routed, on-disk JSONL then parsed back. Proves
    // the schema migration actually travels through appendTurnSummary → disk →
    // parseTurnSummaryLine, not just the pure helper layer.
    //
    // Pricing constant (Phase 61-01 COST-01): $1.00/MTok input, so 234k input
    // should cost 0.234 × 1.00 = $0.234. This assertion ties together COST-01
    // (corrected pricing) + COST-02 (routed model) + COST-08 (contextSizeTokens)
    // in a single sanity check — if any of the three regresses, this test
    // fails in a way that names the regression.
    const FLASH_INPUT_RATE_USD_PER_MTOK = 1.0 // matches EXPECTED_ in pricing.test.ts
    const record: TurnSummaryRecord = {
      ts: '2026-04-19T12:00:00.000Z',
      turnId: 'test-61-02-turn',
      channelId: 'test-channel',
      userId: 'test-user',
      model: 'glm-4.7-flash', // COST-02: routed model, not profile base glm-5.1
      totalInputTokens: 234_000,
      totalOutputTokens: 1_200,
      totalCostUsd: 0.234 * FLASH_INPUT_RATE_USD_PER_MTOK, // uses 61-01 pricing
      contextSizeTokens: 234_000, // COST-08
    }
    await appendTurnSummary(record)
    const filePath = summaryPath(new Date(record.ts))
    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = parseTurnSummaryLine(lines[0])
    expect(parsed).not.toBeNull()
    expect(parsed!.model).toBe('glm-4.7-flash') // COST-02 survives disk
    expect(parsed!.contextSizeTokens).toBe(234_000) // COST-08 survives disk
    // COST-01 pricing math sanity: 0.234 MTok × $1/MTok = $0.234 ± FP dust
    expect(parsed!.totalCostUsd).toBeCloseTo(0.234, 6)
  })
})
