/**
 * Phase 63 (OBS-04, OBS-05): Shared tool-error formatter.
 *
 * Consumed by `daily-dm.ts` (OBS-04 24h digest section) AND `commands.ts`
 * (OBS-05 `!tool-errors` Discord command). Kept in its own module so
 * daily-dm and commands do not depend on each other — mirrors the `isCommand`
 * style of small leaf discord/ modules.
 *
 * Pure function: given a list of ToolErrorSample (already-windowed) and a
 * label, return a formatted string. No I/O, no time dependency beyond the
 * samples' own ts fields.
 */
import type { ToolErrorSample } from '../security/tool-error-metrics.js'

const DEFAULT_TOP_N = 5

interface ToolAggregate {
  tool: string
  count: number
  lastErrorClass: string
  lastTs: number
}

export function formatToolErrorSection(
  samples: ToolErrorSample[],
  windowLabel: string,
  topN: number = DEFAULT_TOP_N,
): string {
  if (samples.length === 0) {
    return `✅ No tool errors in last ${windowLabel}.`
  }

  // Aggregate by tool, tracking the most-recent-sample's errorClass as
  // "last error" for that tool.
  const agg = new Map<string, ToolAggregate>()
  for (const s of samples) {
    const existing = agg.get(s.tool)
    if (!existing) {
      agg.set(s.tool, {
        tool: s.tool,
        count: 1,
        lastErrorClass: s.errorClass,
        lastTs: s.ts,
      })
    } else {
      existing.count += 1
      if (s.ts > existing.lastTs) {
        existing.lastErrorClass = s.errorClass
        existing.lastTs = s.ts
      }
    }
  }

  // Sort by count desc (ties broken by tool name for determinism)
  const sorted = Array.from(agg.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return a.tool.localeCompare(b.tool)
  })

  const top = sorted.slice(0, topN)
  const lines = [`📊 Tool health — last ${windowLabel}:`]
  for (const t of top) {
    lines.push(`  - ${t.tool}: ${t.count} failures (${t.lastErrorClass})`)
  }
  if (sorted.length > topN) {
    lines.push(`  … and ${sorted.length - topN} more`)
  }
  return lines.join('\n')
}
