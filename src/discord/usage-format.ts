/**
 * Phase 35-02 (TOKEN-03): Shared formatting and aggregation logic for
 * Discord token usage display.
 *
 * Used by both the CLI (tm discord usage) and the Discord !usage command.
 * Pure functions — no I/O, no side effects.
 *
 * Phase 59 (D-13, SC#5): formatBreakdown added for `tm discord usage --breakdown`.
 */
import type { UsageRecord } from './usage-store.js'
import type { TurnSummaryRecord } from './turn-summary-store.js'
import { resolveModelPricing } from '../usage/pricing.js'

export interface DayStats {
  input: number
  output: number
  turns: number
}

export interface ChannelStats {
  input: number
  output: number
  turns: number
}

export interface AggregatedUsage {
  totalInput: number
  totalOutput: number
  totalTurns: number
  /** Date string YYYY-MM-DD → aggregated stats */
  byDay: Map<string, DayStats>
  /** Discord channelId → aggregated stats */
  byChannel: Map<string, ChannelStats>
}

/**
 * Aggregate a flat array of UsageRecord into totals, per-day, and per-channel
 * breakdowns.
 */
export function aggregateUsage(records: UsageRecord[]): AggregatedUsage {
  let totalInput = 0
  let totalOutput = 0
  const byDay = new Map<string, DayStats>()
  const byChannel = new Map<string, ChannelStats>()

  for (const r of records) {
    totalInput += r.inputTokens
    totalOutput += r.outputTokens

    const day = r.ts.slice(0, 10)
    const dayEntry = byDay.get(day) ?? { input: 0, output: 0, turns: 0 }
    byDay.set(day, {
      input: dayEntry.input + r.inputTokens,
      output: dayEntry.output + r.outputTokens,
      turns: dayEntry.turns + 1,
    })

    const chEntry = byChannel.get(r.channelId) ?? { input: 0, output: 0, turns: 0 }
    byChannel.set(r.channelId, {
      input: chEntry.input + r.inputTokens,
      output: chEntry.output + r.outputTokens,
      turns: chEntry.turns + 1,
    })
  }

  return {
    totalInput,
    totalOutput,
    totalTurns: records.length,
    byDay,
    byChannel,
  }
}

/**
 * Estimate cost in USD for given token counts and model.
 * Pricing is cost per 1M tokens. Returns 0 when pricing is unavailable.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, { input: number; output: number }> | undefined,
  model: string,
): number {
  if (!pricing) return 0
  const p = pricing[model]
  if (!p) return 0
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

/** Format a number with locale-style comma grouping (e.g. 12345 → "12,345"). */
function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Format aggregated usage as a multi-line plain-text table suitable for
 * terminal display via `tm discord usage`.
 */
export function formatUsageTable(
  agg: AggregatedUsage,
  pricing: Record<string, { input: number; output: number }> | undefined,
  model: string,
): string {
  const total = agg.totalInput + agg.totalOutput
  const cost = estimateCost(agg.totalInput, agg.totalOutput, pricing, model)
  const costLine = pricing ? `  Est. cost: $${cost.toFixed(6)}\n` : ''

  const lines: string[] = [
    'Token Usage Summary',
    '═══════════════════',
    `Total: ${fmt(agg.totalInput)} in / ${fmt(agg.totalOutput)} out (${fmt(total)} total) | ${agg.totalTurns} turn${agg.totalTurns === 1 ? '' : 's'}`,
    costLine.trimEnd(),
    '',
  ]

  if (agg.byDay.size > 0) {
    lines.push('By Day:')
    // Sort days descending (newest first)
    const days = [...agg.byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    for (const [day, s] of days) {
      lines.push(`  ${day}  ${fmt(s.input)} in / ${fmt(s.output)} out  ${s.turns} turn${s.turns === 1 ? '' : 's'}`)
    }
    lines.push('')
  }

  if (agg.byChannel.size > 0) {
    lines.push('By Channel:')
    // Sort channels by total tokens descending
    const channels = [...agg.byChannel.entries()]
      .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))
    for (const [channelId, s] of channels) {
      lines.push(`  #${channelId}  ${fmt(s.input)} in / ${fmt(s.output)} out  ${s.turns} turn${s.turns === 1 ? '' : 's'}`)
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Format usage as a compact single-message string for Discord !usage replies.
 * Kept well under 2000 characters.
 */
export function formatDiscordUsage(
  records: UsageRecord[],
  pricing: Record<string, { input: number; output: number }> | undefined,
  model: string,
): string {
  if (records.length === 0) {
    return 'No usage recorded.'
  }

  const agg = aggregateUsage(records)
  const total = agg.totalInput + agg.totalOutput
  const cost = estimateCost(agg.totalInput, agg.totalOutput, pricing, model)
  const costPart = pricing ? ` | Est. cost: $${cost.toFixed(6)}` : ''

  return [
    '**Usage Summary**',
    `Tokens: ${fmt(agg.totalInput)} in / ${fmt(agg.totalOutput)} out (${fmt(total)} total)`,
    `Turns: ${agg.totalTurns}${costPart}`,
  ].join('\n')
}

/**
 * Phase 59 (D-13, SC#5): Group TurnSummaryRecords by layerBreakdown.routedTo
 * and report total cost per group plus classifier-token overhead.
 *
 * Records without layerBreakdown.routedTo are grouped under "unrouted".
 *
 * Classifier overhead = sum(classifierTokens) × GLM-4.7-Flash output rate
 * (currently $0.00/M on free tier). When rate is 0, reports cost as $0.0000.
 */
export function formatBreakdown(records: TurnSummaryRecord[]): string {
  if (records.length === 0) return 'No turn summaries found for the given date range.\n'

  // Phase 64 (CACHE-04): accumulate cache tokens per routing group. Non-Anthropic
  // workloads (openai-compat Discord) never populate cache fields, so the suffix
  // is omitted entirely when no record has cache tokens — preserving baseline
  // output for non-cache workloads.
  const groups = new Map<string, {
    count: number
    costUsd: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }>()
  let totalClassifierTokens = 0

  for (const r of records) {
    const routedTo = r.layerBreakdown?.routedTo ?? 'unrouted'
    const entry = groups.get(routedTo) ?? {
      count: 0, costUsd: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }
    groups.set(routedTo, {
      count: entry.count + 1,
      costUsd: entry.costUsd + r.totalCostUsd,
      cacheReadTokens: entry.cacheReadTokens + (r.totalCacheReadTokens ?? 0),
      cacheCreationTokens: entry.cacheCreationTokens + (r.totalCacheCreationTokens ?? 0),
    })
    totalClassifierTokens += r.layerBreakdown?.classifierTokens ?? 0
  }

  // Only render cache suffix when at least one group accumulated cache tokens
  const hasCache = [...groups.values()].some(
    g => g.cacheReadTokens > 0 || g.cacheCreationTokens > 0,
  )

  const lines: string[] = ['Cost breakdown by routing decision:']
  for (const [routedTo, stats] of groups) {
    const cacheSuffix = hasCache
      ? `, ${stats.cacheReadTokens} cache_read / ${stats.cacheCreationTokens} cache_create`
      : ''
    lines.push(
      `  ${routedTo}: ${stats.count} turn${stats.count === 1 ? '' : 's'}, $${stats.costUsd.toFixed(4)}${cacheSuffix}`,
    )
  }

  // Classifier overhead — use GLM-4.7-Flash output rate from PRICING_TABLE
  const flashPricing = resolveModelPricing('glm-4.7-flash', undefined)
  const flashOutputRate = flashPricing?.outputPerMToken ?? 0
  const classifierCostUsd = (totalClassifierTokens / 1_000_000) * flashOutputRate
  lines.push(`Classifier overhead: ${totalClassifierTokens} tokens = $${classifierCostUsd.toFixed(4)}`)

  return lines.join('\n') + '\n'
}
