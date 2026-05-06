/**
 * Phase 35-02 (TOKEN-03): CLI handler for `tm discord usage` subcommand.
 *
 * Reads usage JSONL records for a date range, then either outputs a
 * formatted table (default) or JSON (--json flag).
 *
 * Phase 59 (D-13, SC#5): Added --breakdown flag to group TurnSummaryRecord
 * cost by layerBreakdown.routedTo (router decision) and report classifier overhead.
 *
 * Supported flags:
 *   --today (default)  today UTC
 *   --week             last 7 days
 *   --month            last 30 days
 *   --all              since 2020-01-01
 *   --from YYYY-MM-DD  explicit start
 *   --to YYYY-MM-DD    explicit end
 *   --json             output JSON instead of table
 *   --breakdown        group costs by RouterProvider routing decision (Phase 59)
 */
import { readFile } from 'node:fs/promises'
import { loadConfig } from '../config/loader.js'
import { loadUsageRecords } from './usage-store.js'
import { aggregateUsage, estimateCost, formatUsageTable, formatBreakdown } from './usage-format.js'
import { parseTurnSummaryLine, summaryDir } from './turn-summary-store.js'
import type { TurnSummaryRecord } from './turn-summary-store.js'
import { join } from 'node:path'

export interface DateRange {
  from: Date
  to: Date
}

/**
 * Phase 59 (D-13): Detect --breakdown flag in argv.
 * When true, runUsageCli reads TurnSummaryRecords and outputs routing breakdown.
 */
export function parseBreakdownFlag(argv: string[]): boolean {
  return argv.includes('--breakdown')
}

/**
 * Phase 59 (D-13): Load TurnSummaryRecords for a date range from the
 * date-partitioned JSONL store at ~/.telemachus/discord-turn-summaries/.
 * Mirrors loadUsageRecords from usage-store.ts.
 * Missing files are silently skipped — returns [] when no data exists.
 */
export async function loadTurnSummaries(from: Date, to: Date): Promise<TurnSummaryRecord[]> {
  const records: TurnSummaryRecord[] = []
  const dir = summaryDir()

  const current = new Date(from)
  current.setUTCHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setUTCHours(0, 0, 0, 0)

  while (current <= end) {
    const date = current.toISOString().slice(0, 10)
    const filePath = join(dir, `${date}.jsonl`)
    try {
      const content = await readFile(filePath, 'utf8')
      const lines = content.split('\n').filter(l => l.trim() !== '')
      for (const line of lines) {
        const record = parseTurnSummaryLine(line)
        if (record !== null) records.push(record)
      }
    } catch {
      // File not found or unreadable — skip silently
    }
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return records
}

/**
 * Parse CLI argv flags into a { from, to } date range.
 * Exported for unit testing of date-range logic without touching I/O.
 */
export function parseDateRange(argv: string[]): DateRange {
  const now = new Date()
  // Default: today
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))

  // Detect explicit --from / --to
  let from: Date | null = null
  let to: Date | null = null

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--from' && argv[i + 1]) {
      from = parseDateArg(argv[i + 1]!)
      i++
    } else if (flag === '--to' && argv[i + 1]) {
      to = parseDateArg(argv[i + 1]!, true)
      i++
    } else if (flag === '--today') {
      return { from: todayStart, to: todayEnd }
    } else if (flag === '--week') {
      const weekAgo = new Date(todayStart)
      weekAgo.setUTCDate(weekAgo.getUTCDate() - 6)
      return { from: weekAgo, to: todayEnd }
    } else if (flag === '--month') {
      const monthAgo = new Date(todayStart)
      monthAgo.setUTCDate(monthAgo.getUTCDate() - 29)
      return { from: monthAgo, to: todayEnd }
    } else if (flag === '--all') {
      return { from: new Date('2020-01-01T00:00:00.000Z'), to: todayEnd }
    }
  }

  if (from !== null || to !== null) {
    return {
      from: from ?? todayStart,
      to: to ?? todayEnd,
    }
  }

  // Default: today
  return { from: todayStart, to: todayEnd }
}

/**
 * Parse a YYYY-MM-DD string into a UTC Date.
 * When isEnd=true, sets time to end-of-day (23:59:59.999 UTC).
 */
function parseDateArg(s: string, isEnd = false): Date {
  const [year, month, day] = s.split('-').map(Number)
  if (isEnd) {
    return new Date(Date.UTC(year!, (month! - 1), day!, 23, 59, 59, 999))
  }
  return new Date(Date.UTC(year!, (month! - 1), day!))
}

/**
 * Main CLI entry point for `tm discord usage`.
 * Reads config, loads records for the requested date range, outputs table or JSON.
 *
 * Phase 59 (D-13, SC#5): when --breakdown is passed, reads TurnSummaryRecords
 * and outputs RouterProvider cost breakdown via formatBreakdown.
 */
export async function runUsageCli(argv: string[]): Promise<void> {
  const { from, to } = parseDateRange(argv)

  // Phase 59: --breakdown takes precedence over --json and default table
  if (parseBreakdownFlag(argv)) {
    const summaries = await loadTurnSummaries(from, to)
    process.stdout.write(formatBreakdown(summaries))
    process.exit(0)
    return
  }

  const useJson = argv.includes('--json')

  const config = await loadConfig(process.cwd())
  const pricing = config.discord?.pricing
  const model = config.model

  const records = await loadUsageRecords(from, to)
  const aggregated = aggregateUsage(records)

  if (useJson) {
    process.stdout.write(JSON.stringify({ records, aggregated: {
      totalInput: aggregated.totalInput,
      totalOutput: aggregated.totalOutput,
      totalTurns: aggregated.totalTurns,
      byDay: Object.fromEntries(aggregated.byDay),
      byChannel: Object.fromEntries(aggregated.byChannel),
      estimatedCost: estimateCost(aggregated.totalInput, aggregated.totalOutput, pricing, model),
    } }, null, 2) + '\n')
  } else {
    process.stdout.write(formatUsageTable(aggregated, pricing, model))
  }

  process.exit(0)
}
