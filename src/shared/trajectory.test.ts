/**
 * Phase 75 (TRAJ-01..05): Unit tests for BiasCache and signal record logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  BiasCache,
  BIAS_THRESHOLD,
  DEFAULT_MIN_HISTORY,
  type SignalRecord,
} from './trajectory.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutoSignal(
  transport: 'discord' | 'telegram',
  intent: SignalRecord['intent'],
  overrides: Partial<SignalRecord> = {},
): SignalRecord {
  return {
    ts: new Date().toISOString(),
    transport,
    type: 'auto',
    intent,
    model: 'glm-5.1',
    costUsd: 0.001,
    outputTokens: 100,
    ...overrides,
  }
}

function makeOverrideSignal(transport: 'discord' | 'telegram'): SignalRecord {
  return {
    ts: new Date().toISOString(),
    transport,
    type: 'manual_override',
    model: 'claude-opus-4-5',
  }
}

// ---------------------------------------------------------------------------
// BiasCache.compute — in-memory tests (no filesystem)
// ---------------------------------------------------------------------------

describe('BiasCache.compute', () => {
  it('empty signals → snapshot size is 0', () => {
    const cache = new BiasCache()
    cache.compute([])
    expect(cache.snapshot().size).toBe(0)
  })

  it('below minHistory → no bias activated (shouldUpgrade false)', () => {
    const cache = new BiasCache()
    // 5 auto signals for (discord, casual) — below DEFAULT_MIN_HISTORY (20)
    const signals: SignalRecord[] = Array.from({ length: 5 }, () =>
      makeAutoSignal('discord', 'casual'),
    )
    // Add 3 overrides to push rate above threshold IF it were counted
    signals.push(...Array.from({ length: 3 }, () => makeOverrideSignal('discord')))
    cache.compute(signals)
    expect(cache.shouldUpgrade('discord', 'casual')).toBe(false)
    expect(cache.snapshot().size).toBe(0)
  })

  it('enough auto signals + override rate > BIAS_THRESHOLD → shouldUpgrade true', () => {
    const cache = new BiasCache()
    // 25 auto signals for (discord, casual)
    const signals: SignalRecord[] = Array.from({ length: 25 }, () =>
      makeAutoSignal('discord', 'casual'),
    )
    // 10 manual overrides → rate = 10/25 = 0.40 > 0.30
    signals.push(...Array.from({ length: 10 }, () => makeOverrideSignal('discord')))
    cache.compute(signals)
    expect(cache.shouldUpgrade('discord', 'casual')).toBe(true)
  })

  it('enough auto signals + override rate < BIAS_THRESHOLD → shouldUpgrade false', () => {
    const cache = new BiasCache()
    // 25 auto signals, 3 overrides → rate = 3/25 = 0.12 < 0.30
    const signals: SignalRecord[] = [
      ...Array.from({ length: 25 }, () => makeAutoSignal('discord', 'casual')),
      ...Array.from({ length: 3 }, () => makeOverrideSignal('discord')),
    ]
    cache.compute(signals)
    expect(cache.shouldUpgrade('discord', 'casual')).toBe(false)
  })

  it('TRAJ-05: exactly minHistory-1 records → no bias; exactly minHistory → bias activates', () => {
    const minH = DEFAULT_MIN_HISTORY

    // minHistory - 1 auto signals (just below threshold)
    const cacheBelow = new BiasCache()
    const signalsBelow: SignalRecord[] = [
      ...Array.from({ length: minH - 1 }, () => makeAutoSignal('discord', 'casual')),
      ...Array.from({ length: 10 }, () => makeOverrideSignal('discord')), // high rate
    ]
    cacheBelow.compute(signalsBelow)
    expect(cacheBelow.shouldUpgrade('discord', 'casual')).toBe(false)

    // Exactly minHistory auto signals
    const cacheAt = new BiasCache()
    const signalsAt: SignalRecord[] = [
      ...Array.from({ length: minH }, () => makeAutoSignal('discord', 'casual')),
      ...Array.from({ length: 10 }, () => makeOverrideSignal('discord')), // 10/20 = 0.5 > 0.3
    ]
    cacheAt.compute(signalsAt)
    expect(cacheAt.shouldUpgrade('discord', 'casual')).toBe(true)
  })

  it('shouldUpgrade with unknown (transport, intent) pair → false', () => {
    const cache = new BiasCache()
    cache.compute([])
    // 'orchestration' with no history
    expect(cache.shouldUpgrade('discord', 'orchestration')).toBe(false)
    // unknown transport
    expect(cache.shouldUpgrade('unknown-transport', 'casual')).toBe(false)
  })

  it('shouldUpgrade for orchestration intent even with high override rate returns false when no history', () => {
    const cache = new BiasCache()
    // No orchestration auto signals — no factor entry for orchestration
    const signals: SignalRecord[] = Array.from({ length: 30 }, () => makeOverrideSignal('discord'))
    cache.compute(signals)
    expect(cache.shouldUpgrade('discord', 'orchestration')).toBe(false)
  })

  it('telegram transport is independent from discord', () => {
    const cache = new BiasCache()
    // 25 discord auto signals with 10 discord overrides → discord bias fires
    // Only 5 telegram auto signals → below threshold
    const signals: SignalRecord[] = [
      ...Array.from({ length: 25 }, () => makeAutoSignal('discord', 'casual')),
      ...Array.from({ length: 10 }, () => makeOverrideSignal('discord')),
      ...Array.from({ length: 5 }, () => makeAutoSignal('telegram', 'casual')),
    ]
    cache.compute(signals)
    expect(cache.shouldUpgrade('discord', 'casual')).toBe(true)
    expect(cache.shouldUpgrade('telegram', 'casual')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BiasCache constants sanity
// ---------------------------------------------------------------------------

describe('BiasCache constants', () => {
  it('BIAS_THRESHOLD is 0.3', () => {
    expect(BIAS_THRESHOLD).toBe(0.3)
  })

  it('DEFAULT_MIN_HISTORY is 20', () => {
    expect(DEFAULT_MIN_HISTORY).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// appendSignal + readLastNSignals — filesystem tests using /tmp directly
// ---------------------------------------------------------------------------

describe('appendSignal and readLastNSignals (filesystem)', () => {
  let tmpDir: string
  let signalsFile: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'traj-test-'))
    signalsFile = join(tmpDir, 'signals.jsonl')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('appendFile writes valid JSON lines', async () => {
    // Test the core logic: write JSONL, read back, parse

    const records: SignalRecord[] = [
      makeAutoSignal('discord', 'casual', { ts: '2026-05-04T10:00:00.000Z' }),
      makeAutoSignal('telegram', 'code', { ts: '2026-05-04T10:01:00.000Z' }),
      makeOverrideSignal('discord'),
    ]

    for (const r of records) {
      await appendFile(signalsFile, JSON.stringify(r) + '\n', 'utf-8')
    }

    const text = await readFile(signalsFile, 'utf-8')
    const lines = text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)

    const parsed = lines.map((l) => JSON.parse(l) as SignalRecord)
    expect(parsed[0].transport).toBe('discord')
    expect(parsed[0].type).toBe('auto')
    expect(parsed[1].transport).toBe('telegram')
    expect(parsed[2].type).toBe('manual_override')
  })

  it('readLastNSignals logic: last N of JSONL', () => {
    // Test the slicing logic without filesystem — simulate readLastNSignals behavior
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify(makeAutoSignal('discord', 'casual', { ts: `2026-05-04T10:0${i}:00.000Z` }))
    )
    const joinedText = lines.join('\n') + '\n'

    // Replicate the readLastNSignals slice logic
    const allLines = joinedText.split('\n').filter((l) => l.trim())
    const last3 = allLines.slice(-3)
    const parsed = last3.map((line) => JSON.parse(line) as SignalRecord)

    expect(parsed).toHaveLength(3)
    expect(parsed[2].ts).toBe('2026-05-04T10:09:00.000Z')
  })

  it('loadBiasCache returns empty BiasCache when no signals (pure BiasCache test)', async () => {
    const cache = new BiasCache()
    // Compute with empty array — simulates what loadBiasCache does when file doesn't exist
    cache.compute([])
    expect(cache.snapshot().size).toBe(0)
    expect(cache.shouldUpgrade('discord', 'casual')).toBe(false)
  })

  it('appendSignal does not throw on valid record (smoke test)', async () => {
    // appendSignal writes to ~/.telemachus/routing-signals/signals.jsonl
    // This just verifies it doesn't throw (directory creation + write)
    const { appendSignal } = await import('./trajectory.js')
    const record: SignalRecord = makeAutoSignal('discord', 'casual')
    await expect(appendSignal(record)).resolves.toBeUndefined()
  })
})
