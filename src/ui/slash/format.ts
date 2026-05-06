import type { KristosConfig } from '../../config/types.js'
import type { UsageSession, ToolSchemaCost } from '../../usage/tracker.js'
import { getLatestSchemaCost, computePerToolSchemaTokens } from '../../usage/tracker.js'
import type { Tool } from '../../tools/types.js'
import type { ManagedServerView } from '../../mcp/manager.js'
import type { HookConfig } from '../../hooks/types.js'
import { HOOK_EVENTS } from '../../hooks/types.js'
import type { ProfileConfig } from '../../config/types.js'
import type { LoadedContext } from '../../context/loader.js'

export interface PerModelUsage {
  input: number
  output: number
  cost: number
}

const dollars = (n: number): string => `$${n.toFixed(4)}`

/**
 * Render a UsageSession as a multi-line summary string.
 * Pure function — no I/O, no React, no Ink.
 */
export function formatCost(
  session: UsageSession,
  _currentModel: string,
  _currentProvider: string,
  perModel: Map<string, PerModelUsage>,
  schemaCost: ToolSchemaCost | null = getLatestSchemaCost(),
  opts: { verbose?: boolean; tools?: Tool[] } = {},
): string {
  const lines: string[] = ['Session usage:']
  lines.push(
    `  total: ${session.totalInputTokens}↑ ${session.totalOutputTokens}↓  ${dollars(session.totalCost)}`,
  )
  lines.push(`  turns: ${session.turnCount}`)
  // Phase 64 (CACHE-04): surface Anthropic prompt-cache totals when active.
  // Only render when either total is non-zero so non-Anthropic sessions
  // (openai-compat, llamacpp) see the identical pre-plan baseline output.
  if (session.totalCacheReadTokens > 0 || session.totalCacheCreationTokens > 0) {
    lines.push(`  cache reads: ${session.totalCacheReadTokens} tokens`)
    lines.push(`  cache creations: ${session.totalCacheCreationTokens} tokens`)
  }
  if (perModel.size > 0) {
    lines.push('By model:')
    for (const [key, usage] of perModel) {
      lines.push(`  ${key}: ${usage.input}↑ ${usage.output}↓  ${dollars(usage.cost)}`)
    }
  }
  if (schemaCost && (schemaCost.builtin > 0 || schemaCost.mcpTotal > 0)) {
    lines.push('Tool schemas (last turn):')
    const serverEntries = Object.entries(schemaCost.mcpByServer).sort(
      ([a], [b]) => a.localeCompare(b),
    )
    // Align the "tok" column across builtin + mcp total + per-server lines.
    const numberColumn = Math.max(
      String(schemaCost.builtin).length,
      String(schemaCost.mcpTotal).length,
      ...serverEntries.map(([, v]) => String(v).length),
    )
    const pad = (n: number): string => String(n).padStart(numberColumn, ' ')
    lines.push(`  builtin: ${pad(schemaCost.builtin)} tok`)
    if (schemaCost.mcpTotal > 0) {
      lines.push(`  mcp:     ${pad(schemaCost.mcpTotal)} tok total`)
      for (const [server, tokens] of serverEntries) {
        lines.push(`    mcp/${server}: ${pad(tokens)} tok`)
      }
    }
    lines.push('  (schema tokens estimated via gpt-tokenizer; relative, not exact billing)')
  }
  if (opts.verbose && opts.tools && opts.tools.length > 0) {
    const entries = computePerToolSchemaTokens(opts.tools)
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
    if (entries.length > 0) {
      const numberColumn = Math.max(...entries.map((e) => String(e.tokens).length))
      const pad = (n: number): string => String(n).padStart(numberColumn, ' ')
      lines.push('Per-tool breakdown:')
      for (const e of entries) {
        lines.push(`    ${pad(e.tokens)} tok  ${e.name}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Format a lastActivity timestamp as a short relative string.
 * `null` → `—`. Accepts an optional `now` for deterministic tests.
 */
export function formatLastActivity(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return '—'
  const delta = Math.max(0, now - ts)
  if (delta < 10_000) return 'just now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

const MCP_EMPTY_HINT =
  'No MCP servers configured. Set `mcpServers` in ~/.telemachus/config.json.'

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/**
 * Render the list of MCP servers as a fenced monospace table.
 * Columns: NAME, MODE, STATUS, LAST ACTIVITY, TOOLS, TRUST.
 */
export function formatMcp(views: ManagedServerView[], now: number = Date.now()): string {
  if (views.length === 0) return MCP_EMPTY_HINT

  const headers = ['NAME', 'MODE', 'STATUS', 'LAST ACTIVITY', 'TOOLS', 'TRUST']
  const rows: string[][] = views.map((v) => [
    v.name,
    v.mode,
    v.status,
    formatLastActivity(v.lastActivity, now),
    String(v.toolCount),
    v.trustTier,
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  )
  const renderRow = (cells: string[]): string =>
    cells.map((c, i) => padRight(c, widths[i]!)).join('  ').trimEnd()

  const lines: string[] = ['```']
  lines.push(renderRow(headers))
  for (const r of rows) lines.push(renderRow(r))
  lines.push('```')
  return lines.join('\n')
}

/**
 * Help text for the `/mcp` subcommand family.
 */
export function formatMcpHelp(): string {
  return [
    '/mcp — manage MCP servers (session-only, never writes config)',
    '  /mcp                  list all configured servers',
    '  /mcp list             same as /mcp',
    '  /mcp enable <name>    enable a disabled server',
    '  /mcp disable <name>   disable a server (kills if alive)',
    '  /mcp spawn <name>     force-spawn a lazy server',
    '  /mcp kill <name>      terminate a live server',
  ].join('\n')
}

/**
 * Phase 19 (LEAN-01): render the profile list for `/profile`. Marks the
 * active profile with `*` and summarises each profile's mcpServers count
 * (`(all)` when the profile doesn't restrict MCP servers).
 */
export function formatProfile(
  profiles: Record<string, ProfileConfig> | undefined,
  activeName: string | undefined,
): string {
  if (!profiles || Object.keys(profiles).length === 0) {
    return 'No profiles configured. Add `profiles` to ~/.telemachus/config.json.'
  }
  const lines: string[] = ['Profiles (session-only, never writes config):']
  const names = Object.keys(profiles).sort()
  for (const name of names) {
    const profile = profiles[name]!
    const marker = name === activeName ? '*' : ' '
    const mcpSummary =
      profile.mcpServers === undefined
        ? '(all mcpServers)'
        : `${profile.mcpServers.length} mcpServer${profile.mcpServers.length === 1 ? '' : 's'}`
    lines.push(`  ${marker} ${name}  —  ${mcpSummary}`)
  }
  lines.push('')
  lines.push('Usage: /profile <name>  ·  /profile default  (reset)')
  return lines.join('\n')
}

export interface SubagentSummary {
  name: string
  description: string
}

/**
 * Render the list of available subagent types.
 */
export function formatAgents(types: SubagentSummary[]): string {
  if (types.length === 0) return 'Available subagent types: none registered'
  const lines: string[] = [`Available subagent types (${types.length}):`]
  for (const t of types) {
    lines.push(`  • ${t.name} — ${t.description}`)
  }
  return lines.join('\n')
}

/**
 * Phase 28 (ROUTE-03): format current model for /model display.
 * Shows profile attribution when a profile actively overrides provider.
 *
 * @param providerKey - current provider key (e.g. 'llamacpp', 'anthropic')
 * @param model - current model name
 * @param activeProfileName - name of active profile, or undefined if none
 * @param profileOverridesProvider - true when the active profile's provider field differs from top-level
 */
export function formatModel(
  providerKey: string,
  model: string,
  activeProfileName: string | undefined,
  profileOverridesProvider: boolean = false,
): string {
  const base = `${providerKey} / ${model}`
  if (activeProfileName && profileOverridesProvider) {
    return `${base} [profile: ${activeProfileName}]`
  }
  return base
}

/**
 * Render the built-in help text with discoverable tips for switching models,
 * adding providers, and the full slash command list.
 */
export function formatHelp(): string {
  return [
    'Telemachus — slash commands and tips',
    '',
    'Switching models:',
    '  /model                   — inline picker for all configured providers/models',
    '  KC_MODEL=...  kc         — override model at startup',
    '  KC_PROVIDER=... kc       — override provider at startup',
    '',
    'Adding a paid provider (needs API key):',
    '  1. Edit ~/.telemachus/config.json and add under "providers":',
    '     "anthropic": { "apiKey": "sk-ant-...", "baseUrl": "https://api.anthropic.com" }',
    '     "openai":    { "apiKey": "sk-...",     "baseUrl": "https://api.openai.com/v1" }',
    '  2. Or export env vars: ANTHROPIC_API_KEY / OPENAI_API_KEY',
    '  3. Restart kc and run /model to pick the new one',
    '',
    'Adding a local model (no API key):',
    '  1. Install Ollama: https://ollama.com  (or LM Studio)',
    '  2. Pull a tool-capable model: ollama pull qwen2.5-coder:7b',
    '  3. Add to ~/.telemachus/config.json:',
    '     "ollama": { "baseUrl": "http://localhost:11434/v1" }',
    '  4. Run /model — live Ollama models appear automatically',
    '',
    'All slash commands:',
    '  /help                    — this screen',
    '  /model                   — switch provider/model',
    '  /clear                   — reset conversation to system prompt only',
    '  /compact                 — summarise conversation (with preview)',
    '  /plan                    — toggle plan mode on/off',
    '  /cost                    — session token + USD breakdown',
    '  /resume                  — open session picker inline',
    '  /export [file]           — dump session as markdown',
    '  /mcp                     — list mounted MCP servers',
    '  /agents                  — list subagent types',
    '  /hooks                   — list configured hooks',
    '',
    'Permission modes: yolo (no prompts) · ask (default) · plan (read-only + propose) · readonly',
    'Change with: kc --mode <mode>  or  export KC_MODE=<mode>',
  ].join('\n')
}

/**
 * Phase 46 (CTX-03): render the loaded context files as a table showing
 * source, label, bytes, and estimated token count.
 */
export function formatContext(ctx: LoadedContext | null): string {
  if (!ctx || ctx.files.length === 0) {
    return 'No context files loaded.'
  }
  const lines: string[] = ['Loaded context files:']
  lines.push('')
  lines.push('  Source     | File                                    | Bytes  | ~Tokens')
  lines.push('  ----------|----------------------------------------|--------|--------')
  for (const f of ctx.files) {
    const src = f.source.padEnd(9)
    const label = f.label.length > 40 ? '...' + f.label.slice(-37) : f.label.padEnd(40)
    const bytes = String(f.bytes).padStart(6)
    const tokens = String(f.estimatedTokens).padStart(7)
    lines.push(`  ${src} | ${label} | ${bytes} | ${tokens}`)
  }
  lines.push('')
  lines.push(`  Total: ${ctx.totalBytes} bytes, ~${ctx.totalEstimatedTokens} tokens`)
  if (ctx.budgetWarning) {
    lines.push('')
    lines.push(`  ${ctx.budgetWarning}`)
  }
  return lines.join('\n')
}

/**
 * Phase 55 (CONC-01): render effective configuration including semaphore cap.
 * Pure function — no I/O, no React, no Ink.
 */
export function formatConfig(config: KristosConfig): string {
  const lines: string[] = [
    'Effective configuration:',
    `  provider:               ${config.provider}`,
    `  fallbackProvider:       ${config.fallbackProvider ?? '(none)'}`,
    `  model:                  ${config.model}`,
    `  windowSize:             ${config.windowSize}`,
    `  permissionMode:         ${config.permissionMode}`,
    `  temperature:            ${config.temperature}`,
    `  maxIterations:          ${config.maxIterations}`,
    `  toolTimeoutMs:          ${config.toolTimeoutMs}`,
    `  autoCompactThreshold:   ${config.autoCompactThreshold}%`,
    `  contextTokenBudget:     ${config.contextTokenBudget}`,
    `  maxInflightLLMRequests: ${config.maxInflightLLMRequests}`,
    '',
    'Edit: ~/.telemachus/config.json',
  ]
  return lines.join('\n')
}

/**
 * Render the configured hooks grouped by event in HOOK_EVENTS order.
 */
export function formatHooks(config: HookConfig | undefined): string {
  if (!config) return 'Configured hooks: none configured'
  const populated = HOOK_EVENTS.filter((event) => {
    const matchers = config[event]
    return matchers && matchers.length > 0
  })
  if (populated.length === 0) return 'Configured hooks: none configured'

  const lines: string[] = ['Configured hooks:']
  for (const event of populated) {
    const matchers = config[event]!
    lines.push(`  ${event}:`)
    for (const matcher of matchers) {
      const label = matcher.matcher ?? '*'
      for (const hook of matcher.hooks) {
        lines.push(`    [${label}] ${hook.command}`)
      }
    }
  }
  return lines.join('\n')
}
