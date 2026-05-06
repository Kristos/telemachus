/**
 * Phase 63 (OBS-04): Tests for the shared tool-error formatter.
 *
 * bun:test with spyOn only — no mock.module per CLAUDE.md.
 */
import { describe, test, expect } from 'bun:test'
import type { ToolErrorSample } from '../security/tool-error-metrics.js'
import { formatToolErrorSection } from './tool-error-format.js'
import { buildDailySummary } from './daily-dm.js'
import type { UsageRecord } from './usage-store.js'

function mkSample(
  tool: string,
  tsMs: number,
  errorClass: string,
  overrides: Partial<ToolErrorSample> = {},
): ToolErrorSample {
  return {
    ts: tsMs,
    tool,
    errorClass,
    errorMessage: `${errorClass} sample`,
    ...overrides,
  }
}

describe('formatToolErrorSection', () => {
  test('1: 3 tools populated → formatted header + lines with counts + last error class', () => {
    const samples: ToolErrorSample[] = [
      // write_file: 17 failures, latest EROFS
      ...Array.from({ length: 17 }, (_, i) => mkSample('write_file', 1000 + i, 'EROFS')),
      // glob: 9 failures, latest EBADF
      ...Array.from({ length: 9 }, (_, i) => mkSample('glob', 2000 + i, 'EBADF')),
      // write_todos: 7 failures, latest EROFS
      ...Array.from({ length: 7 }, (_, i) => mkSample('write_todos', 3000 + i, 'EROFS')),
    ]
    const out = formatToolErrorSection(samples, '24h')
    expect(out).toContain('📊 Tool health — last 24h:')
    expect(out).toContain('write_file: 17 failures (EROFS)')
    expect(out).toContain('glob: 9 failures (EBADF)')
    expect(out).toContain('write_todos: 7 failures (EROFS)')
    // Ordering: write_file first (highest count)
    const wfIdx = out.indexOf('write_file')
    const glIdx = out.indexOf('glob')
    expect(wfIdx).toBeLessThan(glIdx)
  })

  test('2: empty → positive "no errors" line', () => {
    const out = formatToolErrorSection([], '24h')
    expect(out).toBe('✅ No tool errors in last 24h.')
  })

  test('3: more than 5 tools → top 5 + "… and N more"', () => {
    const samples: ToolErrorSample[] = []
    // 7 distinct tools with counts 7..1 so sorting is deterministic
    const counts = [7, 6, 5, 4, 3, 2, 1]
    counts.forEach((c, idx) => {
      for (let i = 0; i < c; i++) {
        samples.push(mkSample(`tool${idx}`, 1000 + idx * 100 + i, 'Error'))
      }
    })
    const out = formatToolErrorSection(samples, '24h')
    expect(out).toContain('tool0: 7 failures')
    expect(out).toContain('tool4: 3 failures')
    // tool5 and tool6 are the overflow
    expect(out).not.toContain('tool5:')
    expect(out).toContain('… and 2 more')
  })

  test('4: each line shows the MOST-RECENT error class (not an arbitrary one)', () => {
    // First sample is an older ENOENT; second is a newer EROFS.
    const samples: ToolErrorSample[] = [
      mkSample('write_file', 1000, 'ENOENT'),
      mkSample('write_file', 2000, 'EROFS'),
    ]
    const out = formatToolErrorSection(samples, '24h')
    expect(out).toContain('write_file: 2 failures (EROFS)')
    expect(out).not.toContain('ENOENT')
  })

  test('5: topN=3 caps output to 3 lines', () => {
    const samples: ToolErrorSample[] = []
    for (let i = 0; i < 5; i++) {
      samples.push(mkSample(`t${i}`, 1000 + i, 'Err'))
    }
    const out = formatToolErrorSection(samples, '15m', 3)
    // 5 tools with 1 each, alphabetical tie-break
    expect(out).toContain('t0:')
    expect(out).toContain('t1:')
    expect(out).toContain('t2:')
    expect(out).not.toContain('t3:')
    expect(out).not.toContain('t4:')
    expect(out).toContain('… and 2 more')
  })
})

describe('buildDailySummary with tool-error section (OBS-04)', () => {
  function mkRecord(channelId: string, inputTokens: number, outputTokens: number): UsageRecord {
    return {
      ts: '2026-04-19T00:00:00.000Z',
      channelId,
      userId: 'u',
      sessionId: 's',
      turnId: 't',
      inputTokens,
      outputTokens,
      model: 'm',
    } as UsageRecord
  }

  test('6: empty records + tool-error section → section still rendered', () => {
    const section = formatToolErrorSection(
      [
        mkSample('write_file', 1000, 'EROFS'),
        mkSample('write_file', 2000, 'EROFS'),
        mkSample('write_file', 3000, 'EROFS'),
      ],
      '24h',
    )
    const out = buildDailySummary([], undefined, 'claude', section)
    expect(out).toContain('No usage recorded yesterday.')
    expect(out).toContain('write_file: 3 failures (EROFS)')
  })

  test('7: populated records + empty tool-error section → both appear', () => {
    const records = [mkRecord('ch1', 100, 200)]
    const section = formatToolErrorSection([], '24h')
    const out = buildDailySummary(records, undefined, 'claude', section)
    expect(out).toContain('Daily Usage Summary')
    expect(out).toContain('✅ No tool errors in last 24h.')
  })

  test('8: no toolErrorSection arg → backward compat (existing callers)', () => {
    const records = [mkRecord('ch1', 100, 200)]
    const out = buildDailySummary(records, undefined, 'claude')
    expect(out).toContain('Daily Usage Summary')
    expect(out).not.toContain('Tool health')
  })
})
