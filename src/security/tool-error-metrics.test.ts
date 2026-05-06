/**
 * Phase 63 (OBS-02): Ring buffer metrics for tool_error events.
 *
 * Pure in-memory module — no I/O, no Discord, no audit imports beyond types.
 * Tests lock the ring buffer semantics before OBS-03/04/05 consume the API.
 *
 * NO mock.module() — CLAUDE.md forbids it. Each test calls __resetForTests()
 * in beforeEach() so cross-test pollution cannot happen.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import type { AuditEntry } from './audit.js'
import {
  recordError,
  ratePerTool,
  totalErrors,
  getRecentErrors,
  getRecentErrorsForWindow,
  replay,
  __resetForTests,
} from './tool-error-metrics.js'

function mkEntry(overrides: Partial<AuditEntry> & { ts: string; tool: string }): AuditEntry {
  return {
    kind: 'tool_error',
    sessionId: 'test',
    platform: 'darwin',
    errorClass: 'EROFS',
    errorMessage: 'read-only',
    ...overrides,
  }
}

describe('tool-error-metrics ring buffer', () => {
  beforeEach(() => {
    __resetForTests()
  })

  test('1: recordError + ratePerTool(60000) on one tool → Map([[write_file, 1]])', () => {
    const now = 1_000_000
    recordError(mkEntry({ ts: new Date(now).toISOString(), tool: 'write_file' }), () => now)
    const map = ratePerTool(60_000, () => now)
    expect(map.get('write_file')).toBe(1)
    expect(map.size).toBe(1)
  })

  test('2: 3 errors on write_file + 2 on glob within window → both counted', () => {
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkEntry({ ts: new Date(now - 1).toISOString(), tool: 'write_file' }), nowFn)
    recordError(mkEntry({ ts: new Date(now - 2).toISOString(), tool: 'write_file' }), nowFn)
    recordError(mkEntry({ ts: new Date(now - 3).toISOString(), tool: 'write_file' }), nowFn)
    recordError(mkEntry({ ts: new Date(now - 4).toISOString(), tool: 'glob' }), nowFn)
    recordError(mkEntry({ ts: new Date(now - 5).toISOString(), tool: 'glob' }), nowFn)
    const map = ratePerTool(60_000, nowFn)
    expect(map.get('write_file')).toBe(3)
    expect(map.get('glob')).toBe(2)
    expect(totalErrors(60_000, nowFn)).toBe(5)
  })

  test('3: event older than windowMs → excluded from count', () => {
    const now = 10_000_000
    const nowFn = () => now
    // Event from 120s ago — outside 60s window
    recordError(mkEntry({ ts: new Date(now - 120_000).toISOString(), tool: 'write_file' }), nowFn)
    // Event from 30s ago — inside
    recordError(mkEntry({ ts: new Date(now - 30_000).toISOString(), tool: 'write_file' }), nowFn)
    const map = ratePerTool(60_000, nowFn)
    expect(map.get('write_file')).toBe(1)
  })

  test('4: ring buffer overflow (1001 events) → oldest evicted, length ≤1000', () => {
    const baseTs = 1_000_000
    const nowFn = () => baseTs + 2000
    // Record 1001 events, each at a distinct ts so ordering is deterministic.
    // All within the 1h window so age eviction does not mask the count cap.
    for (let i = 0; i < 1001; i++) {
      recordError(mkEntry({ ts: new Date(baseTs + i).toISOString(), tool: 'bash' }), nowFn)
    }
    // Count over 1h window should cap at 1000 because the oldest got evicted.
    expect(totalErrors(60 * 60 * 1000, nowFn)).toBe(1000)
  })

  test('5: age eviction — event from 1h ago dropped when new record pushes past cap', () => {
    // Seed with an ancient event; now record a fresh one at now=3600001.
    const now = 3_600_001
    const nowFnLate = () => now
    recordError(mkEntry({ ts: new Date(0).toISOString(), tool: 'old' }), () => 1)
    recordError(mkEntry({ ts: new Date(now - 1000).toISOString(), tool: 'fresh' }), nowFnLate)
    const map = ratePerTool(60 * 60 * 1000, nowFnLate)
    // 'old' from t=0 is > 1h behind now → excluded even from 1h window
    expect(map.has('old')).toBe(false)
    expect(map.get('fresh')).toBe(1)
  })

  test('6: getRecentErrors(60000, 5) returns most-recent N, newest first', () => {
    const now = 2_000_000
    const nowFn = () => now
    for (let i = 0; i < 10; i++) {
      recordError(
        mkEntry({
          ts: new Date(now - i * 1000).toISOString(),
          tool: `t${i}`,
          errorClass: `C${i}`,
        }),
        nowFn,
      )
    }
    const recent = getRecentErrors(60_000, 5, nowFn)
    expect(recent.length).toBe(5)
    // Newest first: i=0 has ts = now, so t0 must be first
    expect(recent[0]!.tool).toBe('t0')
    expect(recent[1]!.tool).toBe('t1')
    expect(recent[4]!.tool).toBe('t4')
  })

  test('7: replay filters non-tool_error entries', () => {
    const now = 5_000_000
    const nowFn = () => now
    replay(
      [
        mkEntry({ ts: new Date(now - 100).toISOString(), tool: 'write_file' }),
        { kind: 'tool_call', ts: new Date(now).toISOString(), sessionId: 's', platform: 'x' },
        mkEntry({ ts: new Date(now - 50).toISOString(), tool: 'glob' }),
        { kind: 'discord_turn', ts: new Date(now).toISOString(), sessionId: 's', platform: 'x' },
      ],
      nowFn,
    )
    const map = ratePerTool(60_000, nowFn)
    expect(map.get('write_file')).toBe(1)
    expect(map.get('glob')).toBe(1)
    expect(map.size).toBe(2)
  })

  test('8: replay with entries older than 1h — pruned on insert', () => {
    // Inject an old entry via replay; ensure it never surfaces in subsequent
    // ratePerTool calls at a much later `now`.
    const lateNow = 100_000_000
    const nowFn = () => lateNow
    replay(
      [
        mkEntry({ ts: new Date(0).toISOString(), tool: 'ancient' }),
        mkEntry({ ts: new Date(lateNow - 1000).toISOString(), tool: 'fresh' }),
      ],
      nowFn,
    )
    const map = ratePerTool(60 * 60 * 1000, nowFn)
    expect(map.has('ancient')).toBe(false)
    expect(map.get('fresh')).toBe(1)
  })

  test('9: __resetForTests clears state', () => {
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkEntry({ ts: new Date(now).toISOString(), tool: 'bash' }), nowFn)
    expect(totalErrors(60_000, nowFn)).toBe(1)
    __resetForTests()
    expect(totalErrors(60_000, nowFn)).toBe(0)
    expect(ratePerTool(60_000, nowFn).size).toBe(0)
  })

  test('10: recordError on entry with missing tool → no-op', () => {
    const now = 1_000_000
    const nowFn = () => now
    recordError(
      {
        kind: 'tool_error',
        ts: new Date(now).toISOString(),
        sessionId: 's',
        platform: 'x',
        // tool missing — defensive skip
      } as AuditEntry,
      nowFn,
    )
    expect(totalErrors(60_000, nowFn)).toBe(0)
  })

  test('11: recordError on entry with wrong kind → no-op', () => {
    const now = 1_000_000
    const nowFn = () => now
    recordError(
      {
        kind: 'tool_call',
        ts: new Date(now).toISOString(),
        sessionId: 's',
        platform: 'x',
        tool: 'bash',
      } as AuditEntry,
      nowFn,
    )
    expect(totalErrors(60_000, nowFn)).toBe(0)
  })

  test('12: recordError on entry with unparseable ts → no-op', () => {
    const now = 1_000_000
    const nowFn = () => now
    recordError(
      {
        kind: 'tool_error',
        ts: 'not-a-date',
        sessionId: 's',
        platform: 'x',
        tool: 'bash',
      } as AuditEntry,
      nowFn,
    )
    expect(totalErrors(60_000, nowFn)).toBe(0)
  })

  test('13: getRecentErrorsForWindow is pure — does not mutate module buffer', () => {
    const now = 1_000_000
    const nowFn = () => now
    // Seed live buffer with one event
    recordError(mkEntry({ ts: new Date(now - 100).toISOString(), tool: 'live' }), nowFn)
    // Call pure helper with its own entries
    const pureResult = getRecentErrorsForWindow(
      [
        mkEntry({ ts: new Date(now - 50).toISOString(), tool: 'pure-a' }),
        mkEntry({ ts: new Date(now - 25).toISOString(), tool: 'pure-b' }),
        { kind: 'tool_call', ts: new Date(now).toISOString(), sessionId: 's', platform: 'x' },
      ],
      60_000,
      nowFn,
    )
    expect(pureResult.length).toBe(2)
    // Live buffer is unchanged — 'live' still the only entry
    const liveMap = ratePerTool(60_000, nowFn)
    expect(liveMap.size).toBe(1)
    expect(liveMap.get('live')).toBe(1)
  })
})
