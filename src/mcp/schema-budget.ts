import type { Tool } from '../tools/types.js'
import { computePerToolSchemaTokens } from '../usage/tracker.js'

export interface SchemaBudgetOffender {
  name: string
  tokens: number
}

/**
 * Phase 19 LEAN-03: return tools whose schema token count exceeds `budget`,
 * sorted descending by tokens. Never throws; on unexpected errors returns [].
 */
export function checkSchemaBudget(tools: Tool[], budget: number): SchemaBudgetOffender[] {
  try {
    return computePerToolSchemaTokens(tools)
      .filter((e) => e.tokens > budget)
      .map((e) => ({ name: e.name, tokens: e.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
  } catch {
    return []
  }
}

/**
 * Render a single-line stderr warning summarising schema-budget offenders.
 * Empty offenders → empty string so the caller can skip writing.
 */
export function formatBudgetWarning(
  offenders: SchemaBudgetOffender[],
  budget: number,
): string {
  if (offenders.length === 0) return ''
  const list = offenders.map((o) => `${o.name} (${o.tokens})`).join(', ')
  return `[schema-budget] ${offenders.length} tool(s) exceed ${budget} tok: ${list}`
}
