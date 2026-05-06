import type { TurnUsage } from '../providers/types.js'
import type { Tool } from '../tools/types.js'
import { calculateTurnCost } from './pricing.js'
import { encode } from 'gpt-tokenizer'

export interface TurnStats {
  inputTokens: number
  outputTokens: number
  cost: number
  isEstimated: boolean  // true when inputTokens came from gpt-tokenizer, not the API
}

export interface UsageSession {
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  turnCount: number
  lastTurn: TurnStats | null
  /**
   * CACHE-04 (Phase 64): Anthropic prompt-cache token totals for the session.
   * cacheReadTokens: tokens served from ephemeral cache (cost savings).
   * cacheCreationTokens: one-time tokens written to cache on first use.
   * Both stay at 0 for non-Anthropic providers (openai-compat, llamacpp),
   * which never populate these fields in TurnUsage.
   */
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
}

/**
 * Per-turn attribution of tool-schema context tokens, split into builtin vs
 * mcp/<server>. Computed via gpt-tokenizer on the serialized JSON of each
 * tool's name+description+input_schema (D-14, D-15).
 */
export interface ToolSchemaCost {
  builtin: number
  mcpByServer: Record<string, number>
  mcpTotal: number
}

export function createSession(): UsageSession {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    turnCount: 0,
    lastTurn: null,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  }
}

/**
 * Add a completed turn to the session.
 * Returns a new UsageSession (immutable update).
 *
 * If usage.inputTokens === 0 (provider didn't report), estimates using
 * gpt-tokenizer on the provided context text.
 */
export function addTurn(
  session: UsageSession,
  usage: TurnUsage,
  model: string,
  contextText?: string,  // pass the concatenated message text for estimation
): UsageSession {
  let inputTokens = usage.inputTokens
  let isEstimated = false

  // Fallback: estimate via gpt-tokenizer when provider returns 0
  if (inputTokens === 0 && contextText) {
    try {
      inputTokens = encode(contextText).length
      isEstimated = true
    } catch {
      inputTokens = Math.ceil(contextText.length / 4)  // rough char-based fallback
      isEstimated = true
    }
  }

  const outputTokens = usage.outputTokens
  const cost = calculateTurnCost({ inputTokens, outputTokens }, model)

  const lastTurn: TurnStats = { inputTokens, outputTokens, cost, isEstimated }

  return {
    totalInputTokens: session.totalInputTokens + inputTokens,
    totalOutputTokens: session.totalOutputTokens + outputTokens,
    totalCost: session.totalCost + cost,
    turnCount: session.turnCount + 1,
    lastTurn,
    // CACHE-04 (Phase 64): accumulate Anthropic prompt-cache tokens.
    // Non-Anthropic providers leave these at 0 in TurnUsage, so this is a
    // safe additive accumulation across all provider paths.
    totalCacheReadTokens: session.totalCacheReadTokens + (usage.cacheReadTokens ?? 0),
    totalCacheCreationTokens:
      session.totalCacheCreationTokens + (usage.cacheCreationTokens ?? 0),
  }
}

/**
 * Compute per-turn context-token attribution of the tool schemas, split into
 * `builtin` vs `mcp/<server>`. Uses gpt-tokenizer on the serialized JSON
 * of each tool's name+description+input_schema (D-14, D-15).
 *
 * Tool naming convention: MCP tools are prefixed `mcp__<server>__<tool>`;
 * everything else is treated as builtin.
 *
 * Estimates are relative, not exact billing — different providers tokenize
 * differently. The footnote in /cost communicates this caveat.
 */
/**
 * Per-tool attribution: returns one entry per tool with its schema token count
 * and group (`builtin` or `mcp/<server>`). Shared helper used by both
 * `computeToolSchemaTokens` (aggregated view for /cost) and the startup
 * schema-budget check (Phase 19, LEAN-03).
 */
export interface PerToolSchemaCost {
  name: string
  tokens: number
  group: string
}

export function computePerToolSchemaTokens(tools: Tool[]): PerToolSchemaCost[] {
  const entries: PerToolSchemaCost[] = []
  for (const t of tools) {
    const json = JSON.stringify({
      name: t.name,
      description: t.description,
      input_schema: t.rawInputSchema ?? t.inputSchema,
    })
    let tokens: number
    try {
      tokens = encode(json).length
    } catch {
      tokens = Math.ceil(json.length / 4)
    }
    let group: string
    if (t.name.startsWith('mcp__')) {
      const server = t.name.split('__')[1] ?? 'unknown'
      group = `mcp/${server}`
    } else {
      group = 'builtin'
    }
    entries.push({ name: t.name, tokens, group })
  }
  return entries
}

export function computeToolSchemaTokens(tools: Tool[]): ToolSchemaCost {
  let builtin = 0
  const mcpByServer: Record<string, number> = {}

  for (const entry of computePerToolSchemaTokens(tools)) {
    if (entry.group === 'builtin') {
      builtin += entry.tokens
    } else {
      const server = entry.group.slice('mcp/'.length)
      mcpByServer[server] = (mcpByServer[server] ?? 0) + entry.tokens
    }
  }

  const mcpTotal = Object.values(mcpByServer).reduce((a, b) => a + b, 0)
  return { builtin, mcpByServer, mcpTotal }
}

/**
 * Module-level "latest schema cost" — the agent loop records the value
 * once per turn via `recordSchemaCost()`, and the /cost formatter reads
 * it via `getLatestSchemaCost()`.
 *
 * This avoids threading a new field through the App/session state (which
 * lives in React), keeping the /cost wiring localized to tracker + loop +
 * format.
 */
let latestSchemaCost: ToolSchemaCost | null = null

export function recordSchemaCost(cost: ToolSchemaCost): void {
  latestSchemaCost = cost
}

export function getLatestSchemaCost(): ToolSchemaCost | null {
  return latestSchemaCost
}

export function resetLatestSchemaCost(): void {
  latestSchemaCost = null
}
