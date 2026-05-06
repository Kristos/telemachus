/**
 * Phase 35-03 (TOKEN-05): Daily DM scheduler for Discord usage summaries.
 *
 * Sends the bot owner a summary DM once per day at a configurable UTC hour,
 * containing yesterday's token totals, turn count, estimated cost, and top
 * channels by usage.
 *
 * NOTE: aggregateUsage and estimateCost are defined here as local helpers
 * to avoid a dependency on usage-format.ts, which may or may not exist
 * depending on which plan in Phase 35 ran first. When usage-format.ts is
 * available, those functions can replace the local helpers here.
 */
import { loadUsageRecords } from './usage-store.js'
import type { UsageRecord } from './usage-store.js'
import { log } from '../log/logger.js'
import { readFile } from 'node:fs/promises'
import { auditPath, parseAuditLine, type AuditEntry } from '../security/audit.js'
import { getRecentErrorsForWindow } from '../security/tool-error-metrics.js'
import { formatToolErrorSection } from './tool-error-format.js'
import { resolveModelPricing } from '../usage/pricing.js'

// ---------------------------------------------------------------------------
// Local helpers (aggregation + cost)
// ---------------------------------------------------------------------------

interface ChannelStats {
  channelId: string
  inputTokens: number
  outputTokens: number
  turns: number
}

interface AggregatedUsage {
  inputTokens: number
  outputTokens: number
  turns: number
  channels: ChannelStats[]
}

function aggregateUsage(records: UsageRecord[]): AggregatedUsage {
  let inputTokens = 0
  let outputTokens = 0
  const channelMap = new Map<string, ChannelStats>()

  for (const r of records) {
    inputTokens += r.inputTokens
    outputTokens += r.outputTokens

    const existing = channelMap.get(r.channelId)
    if (existing) {
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.turns += 1
    } else {
      channelMap.set(r.channelId, {
        channelId: r.channelId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        turns: 1,
      })
    }
  }

  const channels = Array.from(channelMap.values()).sort(
    (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  )

  return { inputTokens, outputTokens, turns: records.length, channels }
}

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, { input: number; output: number }> | undefined,
  model: string,
): number {
  // Post-v3.8 fix: when operator hasn't supplied discord.pricing overrides,
  // fall back to the static PRICING_TABLE via resolveModelPricing so the
  // daily DM shows "$X" instead of "N/A" for known models (glm-5.1, etc.).
  const resolved = resolveModelPricing(model, pricing ? { pricing } : undefined)
  if (!resolved) return 0
  return (inputTokens / 1_000_000) * resolved.inputPerMToken +
         (outputTokens / 1_000_000) * resolved.outputPerMToken
}

// ---------------------------------------------------------------------------
// msUntilNextFire
// ---------------------------------------------------------------------------

/**
 * Returns milliseconds until the next occurrence of `targetHour` UTC.
 * If the current time is already past `targetHour`, schedules for tomorrow.
 * If `diff` is exactly 0 (fired at the exact second), schedules for 24h later.
 */
export function msUntilNextFire(targetHour: number, now: Date = new Date()): number {
  const utcH = now.getUTCHours()
  const utcM = now.getUTCMinutes()
  const utcS = now.getUTCSeconds()
  const currentMs = (utcH * 3600 + utcM * 60 + utcS) * 1000
  const targetMs = targetHour * 3600 * 1000
  const diff = targetMs - currentMs
  return diff > 0 ? diff : diff + 24 * 3600 * 1000
}

// ---------------------------------------------------------------------------
// buildDailySummary
// ---------------------------------------------------------------------------

/**
 * Build a formatted daily usage summary string from an array of UsageRecords.
 *
 * @param records   All usage records for the day being summarised.
 * @param pricing   Optional per-model pricing (USD per 1M tokens).
 * @param model     The model name to use for cost estimation.
 * @param toolErrorSection  Phase 63 (OBS-04): optional pre-formatted tool-health
 *   block produced by formatToolErrorSection. When present and non-empty, it
 *   is appended with a leading blank line. Backward-compatible — existing
 *   callers that pass only 3 args keep their current output.
 */
export function buildDailySummary(
  records: UsageRecord[],
  pricing: Record<string, { input: number; output: number }> | undefined,
  model: string,
  toolErrorSection?: string,
): string {
  const appendToolSection = (base: string): string => {
    if (toolErrorSection !== undefined && toolErrorSection.length > 0) {
      return `${base}\n\n${toolErrorSection}`
    }
    return base
  }

  if (records.length === 0) {
    return appendToolSection('No usage recorded yesterday.')
  }

  const agg = aggregateUsage(records)
  const total = agg.inputTokens + agg.outputTokens
  const cost = estimateCost(agg.inputTokens, agg.outputTokens, pricing, model)

  // Infer date from first record
  const date = records[0]!.ts.slice(0, 10) // YYYY-MM-DD

  const fmt = (n: number) => n.toLocaleString('en-US')

  const costStr = cost > 0 ? `$${cost.toFixed(4)}` : 'N/A'

  const lines: string[] = [
    `**Daily Usage Summary** (${date})`,
    `Tokens: ${fmt(agg.inputTokens)} in / ${fmt(agg.outputTokens)} out (${fmt(total)} total)`,
    `Turns: ${agg.turns} | Est. cost: ${costStr}`,
    '',
    'Top channels:',
  ]

  const topChannels = agg.channels.slice(0, 5)
  for (const ch of topChannels) {
    const chTotal = ch.inputTokens + ch.outputTokens
    lines.push(`  #${ch.channelId} — ${fmt(chTotal)} tokens (${ch.turns} turns)`)
  }

  return appendToolSection(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Phase 63 (OBS-04): load last-24h tool_error rows from audit JSONL
// ---------------------------------------------------------------------------

/**
 * Read the last 24h of `tool_error` audit rows from yesterday's and today's
 * audit JSONL files. Returns raw AuditEntry[] — caller runs them through
 * getRecentErrorsForWindow so the live watcher's ring buffer is untouched.
 *
 * Best-effort: missing files, parse errors, and disk errors are all silently
 * swallowed so the daily DM still fires even if audit is partially broken.
 *
 * Local to daily-dm rather than a shared helper to keep the dependency
 * surface narrow; a short-term TODO is to dedupe with the nearly-identical
 * replayToolErrors helper in discord/index.ts after Phase 63 ships — but the
 * window and call-site lifecycle differ (1h on bot-startup vs 24h on daily
 * fire), so a shared helper would need a window parameter and is a Phase 65
 * HYG concern, not a Phase 63 scope item.
 */
async function loadLast24hToolErrors(): Promise<AuditEntry[]> {
  const now = Date.now()
  const today = new Date(now)
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  const paths = [auditPath(yesterday), auditPath(today)]
  const entries: AuditEntry[] = []
  for (const p of paths) {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const entry = parseAuditLine(line)
        if (entry.kind === 'tool_error') entries.push(entry)
      } catch {
        // skip unparseable
      }
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// startDailyDmScheduler
// ---------------------------------------------------------------------------

export interface DailyDmDeps {
  /** Function to send a Discord DM to a user. */
  sendDm: (userId: string, text: string) => Promise<void>
  /** Discord snowflake of the bot owner who receives the summary. */
  ownerId: string
  /** Optional per-model pricing for cost estimation. */
  pricing?: Record<string, { input: number; output: number }>
  /** Model name to use for cost estimation. */
  model: string
  /** Hour (0-23 UTC) at which to send the summary. Default 7. */
  targetHour: number
}

/**
 * Starts a scheduler that sends a daily usage summary DM to the owner.
 *
 * The first DM fires at the next occurrence of `targetHour` UTC.
 * Subsequent DMs fire every 24 hours after that.
 *
 * Returns a `stop()` function that cancels the pending timeout — call it
 * during bot shutdown to ensure a clean exit.
 */
export function startDailyDmScheduler(deps: DailyDmDeps): { stop: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null

  const fire = async () => {
    // Load yesterday's records: yesterday 00:00:00 UTC to 23:59:59 UTC
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    yesterday.setUTCHours(0, 0, 0, 0)
    const yesterdayEnd = new Date(yesterday)
    yesterdayEnd.setUTCHours(23, 59, 59, 999)

    // Phase 63 (OBS-04): also compute a top-N tool-failing section over the
    // last 24h. Separate try/catch so a broken audit file cannot break the
    // usage summary (which is the scheduler's primary responsibility).
    let toolErrorSection: string | undefined
    try {
      const entries = await loadLast24hToolErrors()
      const samples = getRecentErrorsForWindow(entries, 24 * 60 * 60 * 1000)
      toolErrorSection = formatToolErrorSection(samples, '24h')
    } catch (err) {
      log(
        'error',
        {
          module: 'discord-daily-dm',
          source: 'discord',
          error: err instanceof Error ? err.message : String(err),
        },
        'failed to compute tool-error section',
      )
    }

    let summary: string
    try {
      const records = await loadUsageRecords(yesterday, yesterdayEnd)
      summary = buildDailySummary(records, deps.pricing, deps.model, toolErrorSection)
    } catch (err) {
      summary = `Failed to load usage data: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      await deps.sendDm(deps.ownerId, summary)
    } catch (err) {
      log('error', { module: 'discord-daily-dm', source: 'discord', userId: deps.ownerId, error: err instanceof Error ? err.message : String(err) }, 'daily DM failed')
    }

    // Schedule next fire in exactly 24 hours
    timeout = setTimeout(() => { void fire() }, 24 * 3_600_000)
    if (typeof timeout === 'object' && timeout !== null && 'unref' in timeout) {
      (timeout as { unref(): void }).unref()
    }
  }

  const ms = msUntilNextFire(deps.targetHour)
  log('info', { module: 'discord-daily-dm', source: 'discord', targetHour: deps.targetHour, nextFireMinutes: Math.round(ms / 60_000) }, 'daily DM scheduler started')

  timeout = setTimeout(() => { void fire() }, ms)
  if (typeof timeout === 'object' && timeout !== null && 'unref' in timeout) {
    (timeout as { unref(): void }).unref()
  }

  return {
    stop: () => {
      if (timeout !== null) {
        clearTimeout(timeout)
        timeout = null
      }
    },
  }
}
