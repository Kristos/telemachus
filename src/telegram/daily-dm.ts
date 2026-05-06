/**
 * Phase 71 (TGNOTIF-01): Telegram daily DM scheduler. Mirrors
 * discord/daily-dm.ts but uses a captured sendMessage(text) helper
 * instead of sendDm(userId, text). Pure functions buildDailySummary
 * and msUntilNextFire are imported from discord/daily-dm.ts.
 */
import { loadUsageRecords } from './usage-store.js'
import type { UsageRecord } from './usage-store.js'
import { buildDailySummary, msUntilNextFire } from '../discord/daily-dm.js'
import { log } from '../log/logger.js'
import { readFile } from 'node:fs/promises'
import { auditPath, parseAuditLine, type AuditEntry } from '../security/audit.js'
import { getRecentErrorsForWindow } from '../security/tool-error-metrics.js'
import { formatToolErrorSection } from '../discord/tool-error-format.js'

export interface TelegramDailyDmDeps {
  /** Sends a message to the owner's chat. chatId is captured at construction. */
  sendMessage: (text: string) => Promise<void>
  pricing?: Record<string, { input: number; output: number }>
  model: string
  /** Hour (0-23 UTC) at which to send the summary. */
  targetHour: number
  /** Injectable loadUsageRecords for testing — avoids mock.module(). */
  loadUsageRecordsFn?: (from: Date, to: Date) => Promise<UsageRecord[]>
  /** Injectable timer factory for deterministic tests. */
  timerFactory?: (cb: () => Promise<void>, ms: number) => { clear: () => void }
}

// Local helper — mirrors discord/daily-dm.ts loadLast24hToolErrors.
// Module tag: 'telegram-daily-dm'.
async function loadLast24hToolErrors(): Promise<AuditEntry[]> {
  const now = Date.now()
  const paths = [auditPath(new Date(now - 24 * 60 * 60 * 1000)), auditPath(new Date(now))]
  const entries: AuditEntry[] = []
  for (const p of paths) {
    let text: string
    try { text = await readFile(p, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const entry = parseAuditLine(line)
        if (entry.kind === 'tool_error') entries.push(entry)
      } catch { /* skip unparseable */ }
    }
  }
  return entries
}

/**
 * Starts a scheduler that sends a daily usage summary to the owner's Telegram
 * chat. First fire at the next `targetHour` UTC; subsequent fires every 24h.
 * Returns stop() to cancel the pending timeout on shutdown.
 */
export function startTelegramDailyDmScheduler(deps: TelegramDailyDmDeps): { stop: () => void } {
  let handle: { clear: () => void } | null = null
  const loadFn = deps.loadUsageRecordsFn ?? loadUsageRecords

  const scheduleNext = (ms: number) => {
    if (deps.timerFactory) {
      handle = deps.timerFactory(fire, ms)
    } else {
      const id = setTimeout(() => { void fire() }, ms)
      if (typeof id === 'object' && id !== null && 'unref' in id) {
        (id as { unref(): void }).unref()
      }
      handle = { clear: () => clearTimeout(id) }
    }
  }

  const fire = async () => {
    handle = null

    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    yesterday.setUTCHours(0, 0, 0, 0)
    const yesterdayEnd = new Date(yesterday)
    yesterdayEnd.setUTCHours(23, 59, 59, 999)

    let toolErrorSection: string | undefined
    try {
      const entries = await loadLast24hToolErrors()
      const samples = getRecentErrorsForWindow(entries, 24 * 60 * 60 * 1000)
      toolErrorSection = formatToolErrorSection(samples, '24h')
    } catch (err) {
      log('error', { module: 'telegram-daily-dm', source: 'telegram', error: err instanceof Error ? err.message : String(err) }, 'failed to compute tool-error section')
    }

    let summary: string
    try {
      const records = await loadFn(yesterday, yesterdayEnd)
      summary = buildDailySummary(records, deps.pricing, deps.model, toolErrorSection)
    } catch (err) {
      summary = `Failed to load usage data: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      await deps.sendMessage(summary)
    } catch (err) {
      log('error', { module: 'telegram-daily-dm', source: 'telegram', error: err instanceof Error ? err.message : String(err) }, 'daily DM failed')
    }

    scheduleNext(24 * 3_600_000)
  }

  const ms = msUntilNextFire(deps.targetHour)
  log('info', { module: 'telegram-daily-dm', source: 'telegram', targetHour: deps.targetHour, nextFireMinutes: Math.round(ms / 60_000) }, 'daily DM scheduler started')
  scheduleNext(ms)

  return {
    stop: () => {
      if (handle !== null) {
        handle.clear()
        handle = null
      }
    },
  }
}
