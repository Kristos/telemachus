// NOTE: trust tiers are security, not UX. The permission prompt is UX — it helps
// the owner avoid mistakes. The tier map is security — it decides what runs without
// prompting and what is fail-closed. Do not confuse the two. Default unknown tools
// to 'dangerous' so a new tool landing in the registry without a tier assignment
// gets prompted, not silently allowed.
export type TrustTier = 'safe' | 'risky' | 'dangerous'

export const TOOL_TIERS: Record<string, TrustTier> = {
  // safe — no state change, no egress
  file_read: 'safe',
  grep: 'safe',
  glob: 'safe',
  todo_write: 'safe',
  ask_user_question: 'safe',
  // risky — bounded state change or egress
  file_write: 'risky',
  file_edit: 'risky',
  web_search: 'risky',
  web_fetch: 'risky',
  // dangerous — arbitrary execution
  bash: 'dangerous',
  task: 'dangerous',
  worktree: 'dangerous',
}

// MCP tier overrides: populated by McpManager at load time from config
// (server-level trustTier / per-tool toolOverrides). Keyed by full tool name
// (e.g. `mcp__foo__bar`). Consulted first by getTier() so MCP-06 is explicit
// and overrideable (D-17, D-18, D-03) rather than relying on the fallthrough.
let mcpTierOverrides: Record<string, TrustTier> = {}

export function setMcpTierOverrides(map: Record<string, TrustTier>): void {
  mcpTierOverrides = { ...map }
}

export function clearMcpTierOverrides(): void {
  mcpTierOverrides = {}
}

// CLI tier overrides (Phase 20, LEAN-02): populated by registerCliTools() at
// config load. Keyed by `cli:<name>` (e.g. `cli:gh`). Consulted AFTER MCP
// overrides so that if an operator ever collides keys, MCP wins — MCP is the
// more dynamic/external surface.
let cliTierOverrides: Record<string, TrustTier> = {}

export function setCliTierOverrides(map: Record<string, TrustTier>): void {
  cliTierOverrides = { ...map }
}

export function clearCliTierOverrides(): void {
  cliTierOverrides = {}
}

/**
 * Phase 20 (LEAN-02) plan 03: set a single cli tier override by key, merging
 * with existing overrides rather than replacing them. Used by the agent loop
 * to inject a sub-command-resolved tier for a specific tool call without
 * disturbing the tiers registered for other cli tools.
 */
export function setCliTierOverride(key: string, tier: TrustTier): void {
  cliTierOverrides[key] = tier
}

export function getTier(toolName: string): TrustTier {
  if (toolName in mcpTierOverrides) return mcpTierOverrides[toolName]!
  if (toolName in cliTierOverrides) return cliTierOverrides[toolName]!
  if (toolName in TOOL_TIERS) return TOOL_TIERS[toolName]!
  return 'dangerous'
}
