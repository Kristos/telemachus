/**
 * Phase 70: Per-turn token usage store for Telegram agent.
 *
 * Appends usage records to date-partitioned JSONL files under
 * ~/.telemachus/telegram-usage/YYYY-MM-DD.jsonl — same pattern as the
 * Discord usage store in src/discord/usage-store.ts.
 *
 * Write failures are swallowed to stderr — usage recording is best-effort
 * and must never interrupt an agent turn.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsonlWriter } from '../discord/jsonl-writer.js'

export interface UsageRecord {
  ts: string          // ISO 8601 UTC
  channelId: string   // Telegram chat ID (as string)
  userId: string      // Telegram user ID (as string)
  model: string       // Model name used for this turn
  inputTokens: number
  outputTokens: number
  /**
   * Phase 57 (D-06): join key to the aggregate TurnSummaryRecord written by
   * the runner's per-turn aggregator. Optional — old records without this
   * field parse fine via parseUsageLine.
   */
  turnId?: string
}

/**
 * Returns the path to the telegram-usage directory.
 * Uses process.env.HOME when available so tests can redirect writes
 * to a temp directory without touching ~/.telemachus.
 */
export function usageDir(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, '.telemachus', 'telegram-usage')
}

/**
 * Returns the path to the JSONL file for a given date.
 */
export function usagePath(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD UTC
  return join(usageDir(), `${date}.jsonl`)
}

// Module-scoped writer. resolveDir/resolvePath are callbacks so tests that
// redirect HOME via process.env between calls still hit the redirected path.
const usageWriter = new JsonlWriter({
  resolveDir: usageDir,
  resolvePath: usagePath,
  module: 'telegram-usage-store',
  warnContext: (r) => ({ userId: (r as UsageRecord).userId }),
})

/**
 * Append a usage record to the date-partitioned JSONL file.
 * Fire-and-forget safe — errors go to stderr, never throws.
 */
export async function appendUsage(record: UsageRecord): Promise<void> {
  await usageWriter.append(record)
}

/**
 * Parse a single JSONL line into a UsageRecord.
 * Returns null if the line is malformed or missing required fields.
 */
export function parseUsageLine(line: string): UsageRecord | null {
  if (!line || line.trim() === '') return null
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    // Validate all required fields are present with correct types
    if (
      typeof obj['ts'] !== 'string' ||
      typeof obj['channelId'] !== 'string' ||
      typeof obj['userId'] !== 'string' ||
      typeof obj['model'] !== 'string' ||
      typeof obj['inputTokens'] !== 'number' ||
      typeof obj['outputTokens'] !== 'number'
    ) {
      return null
    }
    const turnId = typeof obj['turnId'] === 'string' ? obj['turnId'] : undefined
    return {
      ts: obj['ts'],
      channelId: obj['channelId'],
      userId: obj['userId'],
      model: obj['model'],
      inputTokens: obj['inputTokens'],
      outputTokens: obj['outputTokens'],
      ...(turnId !== undefined ? { turnId } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Load usage records for a date range [from, to] inclusive.
 * Iterates each YYYY-MM-DD date in the range, reads the corresponding file,
 * parses each line (skipping malformed ones), and returns the flat array
 * sorted by timestamp ascending.
 *
 * Missing files are silently skipped — returns [] when no data exists.
 */
export async function loadUsageRecords(from: Date, to: Date): Promise<UsageRecord[]> {
  const records: UsageRecord[] = []

  // Iterate dates from `from` to `to` inclusive
  const current = new Date(from)
  // Normalize to midnight UTC to avoid partial-day issues
  current.setUTCHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setUTCHours(0, 0, 0, 0)

  while (current <= end) {
    const filePath = usagePath(current)
    try {
      const content = await readFile(filePath, 'utf8')
      const lines = content.split('\n').filter(l => l.trim() !== '')
      for (const line of lines) {
        const record = parseUsageLine(line)
        if (record !== null) {
          records.push(record)
        }
      }
    } catch {
      // File not found or unreadable — skip silently
    }
    // Advance by one day
    current.setUTCDate(current.getUTCDate() + 1)
  }

  // Sort by timestamp ascending
  records.sort((a, b) => a.ts.localeCompare(b.ts))

  return records
}
