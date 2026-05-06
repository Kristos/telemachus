/**
 * Phase 23-03 (AGENT-06): `tm agent status` — read-only run history viewer.
 *
 * This module is strictly read-only. It never writes artifacts, never touches
 * the network, and never imports any module on the agent execution path
 * (run-job, build-parent, providers, loops). Allowed imports: node:fs/promises,
 * node:path, node:util, node:os. That invariant is what makes `tm agent status`
 * safe to run while another headless job is executing.
 *
 * Layout read (written by Phase 22-02 + 23-02):
 *   ~/.telemachus/agent-runs/<jobName>/<sanitized-timestamp>/
 *     usage.json   — { duration_ms, turn_count, exit_reason, error }
 *     webhook.json — optional { format, ok, status?, error? }
 *
 * NOTE on fields the plan's interface mentioned but the Phase 22 writer does
 * NOT produce:
 *   - `startedAt` is NOT in usage.json. We derive it from the run-dir name,
 *     which is the sanitized ISO timestamp of the run start. That's exact,
 *     not an approximation — `sanitizeTimestamp` is lossless down to seconds.
 *   - `tokens` is NOT tracked by the Phase 22 agent loop. We surface it as
 *     null (displayed as "?") until a future phase adds token accounting.
 *
 * Both are deviation Rule 1 / 2 (plan interface didn't match reality) and are
 * documented in 23-03-SUMMARY.md.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

export interface StatusRow {
  job: string
  startedAt: string // ISO (derived from run-dir name)
  durationMs: number | null
  tokens: number | null
  exitReason: string // 'natural' | 'max_iter' | ... | 'corrupt'
  webhook: string | null // 'slack ✓' | 'slack ✗' | null if no webhook.json
}

export interface LoadStatusOpts {
  jobName?: string
  limit: number
}

// ————————————————————————————————————————————————————————————————————————
// Pure formatters
// ————————————————————————————————————————————————————————————————————————

const EMPTY_MESSAGE = 'No agent runs found in ~/.telemachus/agent-runs/\n'

/**
 * Reverse of artifacts.ts sanitizeTimestamp: turn `2026-04-08T14-30-00Z`
 * back into `2026-04-08T14:30:00Z` so it parses as a real ISO date.
 */
export function unsanitizeTimestamp(runDirName: string): string {
  // Match `YYYY-MM-DDTHH-MM-SSZ` and put colons back in the time portion.
  const m = runDirName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/)
  if (!m) return runDirName // leave weird names alone
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
}

/** Format milliseconds as human-friendly duration. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '?'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) {
    const s = totalSec % 60
    return `${totalMin}m ${s}s`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}h ${m}m`
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM:SS` in UTC. Deterministic
 * across timezones — critical for tests, also fine for operators reading
 * logs on a server.
 */
export function formatStarted(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

/**
 * Pure table formatter. Empty rows → the empty-state message. Otherwise a
 * space-padded aligned table with header + separator + data rows.
 */
export function formatStatusTable(rows: StatusRow[]): string {
  if (rows.length === 0) return EMPTY_MESSAGE

  const headers = ['NAME', 'STARTED', 'DURATION', 'TOKENS', 'EXIT', 'WEBHOOK']
  const data = rows.map((r) => [
    r.job,
    formatStarted(r.startedAt),
    formatDuration(r.durationMs),
    r.tokens === null || r.tokens === undefined ? '?' : String(r.tokens),
    r.exitReason,
    r.webhook ?? '—',
  ])

  // Column widths = max of header vs all data cells.
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  )

  const pad = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()

  const sep = widths.map((w) => '-'.repeat(w)).join('  ')

  const lines = [pad(headers), sep, ...data.map(pad)]
  return lines.join('\n') + '\n'
}

// ————————————————————————————————————————————————————————————————————————
// IO: filesystem reader
// ————————————————————————————————————————————————————————————————————————

/** Default artifact root. Overridable for tests. */
export function defaultBasePath(): string {
  const home = process.env.HOME ?? homedir()
  return path.join(home, '.telemachus', 'agent-runs')
}

/**
 * For tests: hook to count fs.readFile calls so we can assert the loader
 * is truly lazy (≤ 2 × limit reads). Default no-op.
 */
export interface LoadStatusDeps {
  readFile?: (p: string) => Promise<string>
}

interface Entry {
  job: string
  runDirName: string
  runDir: string
}

/**
 * Load recent StatusRows. Lazy: lists job dirs and run dirs, sorts in
 * memory (cheap — just strings), slices to limit, THEN reads usage.json +
 * webhook.json only for the surviving rows. Total reads capped at 2 × limit.
 */
export async function loadStatusRows(
  opts: LoadStatusOpts,
  basePath: string = defaultBasePath(),
  deps: LoadStatusDeps = {},
): Promise<StatusRow[]> {
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))

  // 1. List job directories (or just the filter target).
  let jobNames: string[]
  if (opts.jobName) {
    jobNames = [opts.jobName]
  } else {
    try {
      const all = await fs.readdir(basePath, { withFileTypes: true })
      jobNames = all.filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
  }

  // 2. Collect all run-dir entries (path-level only, no file reads yet).
  const entries: Entry[] = []
  for (const job of jobNames) {
    const jobPath = path.join(basePath, job)
    let runDirs: string[]
    try {
      const all = await fs.readdir(jobPath, { withFileTypes: true })
      runDirs = all
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const name of runDirs) {
      entries.push({ job, runDirName: name, runDir: path.join(jobPath, name) })
    }
  }

  // 3. Sort newest first by run-dir name (ISO-ish timestamps sort
  //    lexicographically in chronological order).
  entries.sort((a, b) => (a.runDirName < b.runDirName ? 1 : a.runDirName > b.runDirName ? -1 : 0))

  // 4. Slice to limit BEFORE doing any file IO. Hard cap at 2 × limit on
  //    file reads (usage.json + optional webhook.json per row).
  const survivors = entries.slice(0, opts.limit)

  const rows: StatusRow[] = []
  for (const e of survivors) {
    const startedAt = unsanitizeTimestamp(e.runDirName)
    let row: StatusRow = {
      job: e.job,
      startedAt,
      durationMs: null,
      tokens: null,
      exitReason: 'corrupt',
      webhook: null,
    }

    // usage.json — required; missing/malformed → corrupt row (not a throw).
    try {
      const raw = await readFile(path.join(e.runDir, 'usage.json'))
      const parsed = JSON.parse(raw) as {
        duration_ms?: number
        exit_reason?: string
        tokens?: number
      }
      row = {
        ...row,
        durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
        tokens: typeof parsed.tokens === 'number' ? parsed.tokens : null,
        exitReason:
          typeof parsed.exit_reason === 'string' && parsed.exit_reason.length > 0
            ? parsed.exit_reason
            : 'corrupt',
      }
    } catch {
      // leave row as corrupt
    }

    // webhook.json — optional. Absent = null, present = format ✓/✗.
    try {
      const raw = await readFile(path.join(e.runDir, 'webhook.json'))
      const parsed = JSON.parse(raw) as { format?: string; ok?: boolean }
      const fmt = parsed.format ?? 'webhook'
      row.webhook = parsed.ok ? `${fmt} ✓` : `${fmt} ✗`
    } catch {
      // no webhook.json or unreadable → null (already set)
    }

    rows.push(row)
  }

  return rows
}

// ————————————————————————————————————————————————————————————————————————
// CLI entry point
// ————————————————————————————————————————————————————————————————————————

/**
 * Parse argv and dispatch the status command. Returns an exit code — the
 * caller in index.ts is responsible for process.exit(). That keeps this
 * testable (no process.exit in a unit test).
 *
 *   tm agent status                 → all jobs, limit=20
 *   tm agent status <name>          → one job,  limit=50
 *   tm agent status --limit N       → override
 *   tm agent status <name> --limit N
 */
export async function runStatusCommand(
  argv: string[],
  basePath?: string,
): Promise<number> {
  let parsed: {
    values: { limit?: string }
    positionals: string[]
  }
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        limit: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const jobName = parsed.positionals[0]
  const defaultLimit = jobName ? 50 : 20

  let limit = defaultLimit
  if (parsed.values.limit !== undefined) {
    const n = Number(parsed.values.limit)
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write('Error: --limit must be a positive integer\n')
      return 1
    }
    limit = n
  }

  const rows = await loadStatusRows({ jobName, limit }, basePath)
  const table = formatStatusTable(rows)
  process.stdout.write(table)
  return 0
}
