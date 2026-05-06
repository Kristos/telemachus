/**
 * Phase 23-03 (AGENT-06): tests for `tm agent status`.
 *
 * Tests split into three describes:
 *   - formatStatusTable (pure, no fs)
 *   - loadStatusRows (tmp dir via fs.mkdtemp)
 *   - runStatusCommand (argv parsing + exit codes, tmp dir for empty case)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  formatStatusTable,
  formatDuration,
  formatStarted,
  unsanitizeTimestamp,
  loadStatusRows,
  runStatusCommand,
  type StatusRow,
} from './status.js'

// ————————————————————————————————————————————————————————————————————————
// Helpers
// ————————————————————————————————————————————————————————————————————————

function row(overrides: Partial<StatusRow> = {}): StatusRow {
  return {
    job: 'test',
    startedAt: '2026-04-08T14:30:00Z',
    durationMs: 18000,
    tokens: 1234,
    exitReason: 'natural',
    webhook: null,
    ...overrides,
  }
}

async function makeFakeRun(
  baseDir: string,
  jobName: string,
  runDirName: string, // sanitized (no colons)
  usage?: unknown,
  webhook?: unknown,
): Promise<string> {
  const runDir = path.join(baseDir, jobName, runDirName)
  await fs.mkdir(runDir, { recursive: true })
  if (usage !== undefined) {
    const payload =
      typeof usage === 'string' ? usage : JSON.stringify(usage)
    await fs.writeFile(path.join(runDir, 'usage.json'), payload, 'utf8')
  }
  if (webhook !== undefined) {
    await fs.writeFile(
      path.join(runDir, 'webhook.json'),
      JSON.stringify(webhook),
      'utf8',
    )
  }
  return runDir
}

// ————————————————————————————————————————————————————————————————————————
// formatStatusTable + helpers (pure)
// ————————————————————————————————————————————————————————————————————————

describe('formatDuration', () => {
  test('null → ?', () => {
    expect(formatDuration(null)).toBe('?')
  })
  test('18000ms → 18s', () => {
    expect(formatDuration(18000)).toBe('18s')
  })
  test('134000ms → 2m 14s', () => {
    expect(formatDuration(134000)).toBe('2m 14s')
  })
  test('7200000ms → 2h 0m', () => {
    expect(formatDuration(7200000)).toBe('2h 0m')
  })
  test('0ms → 0s', () => {
    expect(formatDuration(0)).toBe('0s')
  })
})

describe('formatStarted', () => {
  test('ISO → YYYY-MM-DD HH:MM:SS in UTC', () => {
    expect(formatStarted('2026-04-08T14:30:00Z')).toBe('2026-04-08 14:30:00')
  })
  test('ISO with milliseconds', () => {
    expect(formatStarted('2026-04-08T14:30:00.123Z')).toBe('2026-04-08 14:30:00')
  })
  test('invalid → passthrough', () => {
    expect(formatStarted('garbage')).toBe('garbage')
  })
})

describe('unsanitizeTimestamp', () => {
  test('sanitized → canonical ISO', () => {
    expect(unsanitizeTimestamp('2026-04-08T14-30-00Z')).toBe('2026-04-08T14:30:00Z')
  })
  test('non-matching name → passthrough', () => {
    expect(unsanitizeTimestamp('weird-name')).toBe('weird-name')
  })
})

describe('formatStatusTable', () => {
  test('empty rows → empty-state message', () => {
    expect(formatStatusTable([])).toBe(
      'No agent runs found in ~/.telemachus/agent-runs/\n',
    )
  })

  test('single row renders header + separator + data', () => {
    const out = formatStatusTable([row()])
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(3) // header, sep, 1 data row
    expect(lines[0]).toContain('NAME')
    expect(lines[0]).toContain('STARTED')
    expect(lines[0]).toContain('DURATION')
    expect(lines[0]).toContain('TOKENS')
    expect(lines[0]).toContain('EXIT')
    expect(lines[0]).toContain('WEBHOOK')
    expect(lines[2]).toContain('test')
    expect(lines[2]).toContain('2026-04-08 14:30:00')
    expect(lines[2]).toContain('18s')
    expect(lines[2]).toContain('1234')
    expect(lines[2]).toContain('natural')
  })

  test('multiple rows: columns aligned to widest cell', () => {
    const out = formatStatusTable([
      row({ job: 'a' }),
      row({ job: 'longer-name' }),
    ])
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(4) // header, sep, 2 data rows
    // Both job names present
    expect(out).toContain('longer-name')
    expect(out).toContain('a ') // 'a' padded with space before next column
    // Header NAME column padded to at least 'longer-name' width
    expect(lines[0]!.indexOf('STARTED')).toBeGreaterThanOrEqual('longer-name'.length)
  })

  test('corrupt row: ? / ? / corrupt / —', () => {
    const out = formatStatusTable([
      row({
        durationMs: null,
        tokens: null,
        exitReason: 'corrupt',
        webhook: null,
      }),
    ])
    expect(out).toContain('corrupt')
    expect(out).toContain('?')
    expect(out).toContain('—')
  })

  test('webhook=null → —', () => {
    const out = formatStatusTable([row({ webhook: null })])
    expect(out).toContain('—')
  })

  test('webhook="slack ✗" preserved verbatim', () => {
    const out = formatStatusTable([row({ webhook: 'slack ✗' })])
    expect(out).toContain('slack ✗')
  })

  test('output ends in newline', () => {
    expect(formatStatusTable([row()]).endsWith('\n')).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————————————
// loadStatusRows (IO)
// ————————————————————————————————————————————————————————————————————————

describe('loadStatusRows', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-status-'))
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('empty directory → []', async () => {
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows).toEqual([])
  })

  test('nonexistent directory → []', async () => {
    const rows = await loadStatusRows(
      { limit: 20 },
      path.join(tmpDir, 'does-not-exist'),
    )
    expect(rows).toEqual([])
  })

  test('single job, single run → 1 row with parsed fields', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', {
      duration_ms: 5000,
      turn_count: 3,
      exit_reason: 'natural',
      error: null,
    })
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.job).toBe('test')
    expect(rows[0]!.startedAt).toBe('2026-04-08T14:30:00Z')
    expect(rows[0]!.durationMs).toBe(5000)
    expect(rows[0]!.exitReason).toBe('natural')
    expect(rows[0]!.webhook).toBeNull()
  })

  test('single job, 3 run dirs → newest first', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T10-00-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', {
      duration_ms: 2000,
      exit_reason: 'natural',
    })
    await makeFakeRun(tmpDir, 'test', '2026-04-08T12-15-00Z', {
      duration_ms: 3000,
      exit_reason: 'natural',
    })
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows).toHaveLength(3)
    expect(rows[0]!.startedAt).toBe('2026-04-08T14:30:00Z')
    expect(rows[1]!.startedAt).toBe('2026-04-08T12:15:00Z')
    expect(rows[2]!.startedAt).toBe('2026-04-08T10:00:00Z')
  })

  test('jobName filter: only that job returned', async () => {
    await makeFakeRun(tmpDir, 'auction', '2026-04-08T10-00-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', {
      duration_ms: 2000,
      exit_reason: 'natural',
    })
    const rows = await loadStatusRows({ jobName: 'auction', limit: 20 }, tmpDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.job).toBe('auction')
  })

  test('limit=2 with 5 runs → exactly 2 rows', async () => {
    for (let i = 0; i < 5; i++) {
      await makeFakeRun(tmpDir, 'test', `2026-04-08T1${i}-00-00Z`, {
        duration_ms: 1000,
        exit_reason: 'natural',
      })
    }
    const rows = await loadStatusRows({ limit: 2 }, tmpDir)
    expect(rows).toHaveLength(2)
  })

  test('missing usage.json → corrupt row, never throws', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z') // no usage
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.exitReason).toBe('corrupt')
    expect(rows[0]!.durationMs).toBeNull()
    expect(rows[0]!.tokens).toBeNull()
  })

  test('malformed usage.json → corrupt row', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', '{not valid json')
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.exitReason).toBe('corrupt')
  })

  test('webhook.json ok=true → "<format> ✓"', async () => {
    await makeFakeRun(
      tmpDir,
      'test',
      '2026-04-08T14-30-00Z',
      { duration_ms: 1000, exit_reason: 'natural' },
      { format: 'slack', ok: true, status: 200 },
    )
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows[0]!.webhook).toBe('slack ✓')
  })

  test('webhook.json ok=false → "<format> ✗"', async () => {
    await makeFakeRun(
      tmpDir,
      'test',
      '2026-04-08T14-30-00Z',
      { duration_ms: 1000, exit_reason: 'natural' },
      { format: 'slack', ok: false, error: 'HTTP 500' },
    )
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows[0]!.webhook).toBe('slack ✗')
  })

  test('no webhook.json → webhook null', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    expect(rows[0]!.webhook).toBeNull()
  })

  test('performance: 500 runs, limit=20, <200ms', async () => {
    // Build 500 fake run dirs under a single job.
    for (let i = 0; i < 500; i++) {
      const ts = `2026-04-08T${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00Z`
      // Avoid duplicate dirnames — pad to unique by index.
      const unique = `2026-04-${String(Math.floor(i / 100) + 1).padStart(2, '0')}T${String(Math.floor((i % 100) / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00Z`
      void ts
      await makeFakeRun(tmpDir, 'test', unique, {
        duration_ms: 1000,
        exit_reason: 'natural',
      })
    }
    const start = performance.now()
    const rows = await loadStatusRows({ limit: 20 }, tmpDir)
    const elapsed = performance.now() - start
    expect(rows).toHaveLength(20)
    expect(elapsed).toBeLessThan(200)
  }, 15000)

  test('lazy: 500 dirs, limit=20 → ≤40 file reads', async () => {
    for (let i = 0; i < 500; i++) {
      const unique = `2026-04-${String(Math.floor(i / 100) + 1).padStart(2, '0')}T${String(Math.floor((i % 100) / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00Z`
      await makeFakeRun(tmpDir, 'test', unique, {
        duration_ms: 1000,
        exit_reason: 'natural',
      })
    }
    let readCount = 0
    const countingReadFile = async (p: string): Promise<string> => {
      readCount++
      return fs.readFile(p, 'utf8')
    }
    const rows = await loadStatusRows(
      { limit: 20 },
      tmpDir,
      { readFile: countingReadFile },
    )
    expect(rows).toHaveLength(20)
    // 20 usage.json reads + 20 webhook.json reads (which will fail, but count).
    expect(readCount).toBeLessThanOrEqual(40)
  }, 15000)
})

// ————————————————————————————————————————————————————————————————————————
// runStatusCommand
// ————————————————————————————————————————————————————————————————————————

describe('runStatusCommand', () => {
  let tmpDir: string
  let stdoutBuf: string
  let stderrBuf: string
  let origStdoutWrite: typeof process.stdout.write
  let origStderrWrite: typeof process.stderr.write

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-status-cmd-'))
    stdoutBuf = ''
    stderrBuf = ''
    origStdoutWrite = process.stdout.write.bind(process.stdout)
    origStderrWrite = process.stderr.write.bind(process.stderr)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stdout.write = ((chunk: any) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString()
      return true
    }) as typeof process.stdout.write
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString()
      return true
    }) as typeof process.stderr.write
  })

  afterEach(async () => {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('empty argv, empty dir → prints empty-state, returns 0', async () => {
    const code = await runStatusCommand([], tmpDir)
    expect(code).toBe(0)
    expect(stdoutBuf).toContain('No agent runs found')
  })

  test('argv=[] with a run → prints table', async () => {
    await makeFakeRun(tmpDir, 'test', '2026-04-08T14-30-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    const code = await runStatusCommand([], tmpDir)
    expect(code).toBe(0)
    expect(stdoutBuf).toContain('NAME')
    expect(stdoutBuf).toContain('test')
  })

  test('argv=["auction"] filters to job', async () => {
    await makeFakeRun(tmpDir, 'auction', '2026-04-08T14-30-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    await makeFakeRun(tmpDir, 'other', '2026-04-08T14-30-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    const code = await runStatusCommand(['auction'], tmpDir)
    expect(code).toBe(0)
    expect(stdoutBuf).toContain('auction')
    expect(stdoutBuf).not.toContain('other')
  })

  test('argv=["--limit","5"] parses limit', async () => {
    for (let i = 0; i < 10; i++) {
      const unique = `2026-04-0${(i % 9) + 1}T1${i % 10}-00-00Z`
      await makeFakeRun(tmpDir, 'test', unique, {
        duration_ms: 1000,
        exit_reason: 'natural',
      })
    }
    const code = await runStatusCommand(['--limit', '5'], tmpDir)
    expect(code).toBe(0)
    // header + sep + 5 data rows = 7 lines
    const lineCount = stdoutBuf.trimEnd().split('\n').length
    expect(lineCount).toBe(7)
  })

  test('argv with job + --limit', async () => {
    await makeFakeRun(tmpDir, 'auction', '2026-04-08T14-30-00Z', {
      duration_ms: 1000,
      exit_reason: 'natural',
    })
    const code = await runStatusCommand(
      ['auction', '--limit', '10'],
      tmpDir,
    )
    expect(code).toBe(0)
    expect(stdoutBuf).toContain('auction')
  })

  test('--limit=notanumber → stderr, returns 1', async () => {
    const code = await runStatusCommand(['--limit', 'notanumber'], tmpDir)
    expect(code).toBe(1)
    expect(stderrBuf).toContain('--limit must be a positive integer')
  })

  test('--limit=0 → error, returns 1', async () => {
    const code = await runStatusCommand(['--limit', '0'], tmpDir)
    expect(code).toBe(1)
    expect(stderrBuf).toContain('--limit must be a positive integer')
  })

  test('--limit=-1 → error, returns 1', async () => {
    // parseArgs may choke on leading dash — handle either path.
    const code = await runStatusCommand(['--limit', '-1'], tmpDir)
    expect(code).toBe(1)
  })
})
