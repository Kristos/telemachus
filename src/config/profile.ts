/**
 * Phase 19 (LEAN-01): profile resolution + MCP manifest filtering.
 *
 * Pure functions — no I/O besides stderr warnings for dropped unknown
 * server names. Used at startup (via CLI --profile flag) and in-session
 * (via the /profile slash command) to determine which subset of the
 * configured mcpServers should be registered as LLM tools.
 *
 * Precedence for `resolveActiveProfile`:
 *   1. sessionOverride   (/profile <name>)
 *   2. cliFlag           (kc --profile <name>)
 *   3. config.activeProfile
 *   4. undefined         (v1.3 fallback: all mcpServers registered)
 *
 * The special tokens `default` and `reset` in EITHER cliFlag or
 * sessionOverride reset to config.activeProfile? → undefined, bypassing
 * the precedence chain below that level.
 */

import type { KristosConfig, McpServerConfig, CliToolConfig } from './types.js'

export const PROFILE_RESET_TOKENS: ReadonlySet<string> = new Set(['default', 'reset'])

function isReset(token: string | undefined): boolean {
  return token !== undefined && PROFILE_RESET_TOKENS.has(token)
}

function assertKnownProfile(config: KristosConfig, name: string): void {
  const available = listProfileNames(config)
  if (available.includes(name)) return
  const hint =
    available.length > 0
      ? `Available profiles: ${available.join(', ')}`
      : 'No profiles configured. Add `profiles` to ~/.telemachus/config.json.'
  throw new Error(`Unknown profile '${name}'. ${hint}`)
}

/**
 * Resolve the active profile name given the precedence chain.
 *
 * - Reset tokens (`default` / `reset`) in either slot short-circuit to undefined.
 * - Unknown profile names throw with a helpful message.
 */
export function resolveActiveProfile(
  config: KristosConfig,
  cliFlag: string | undefined,
  sessionOverride: string | undefined,
): string | undefined {
  if (isReset(sessionOverride)) return undefined
  if (sessionOverride !== undefined) {
    assertKnownProfile(config, sessionOverride)
    return sessionOverride
  }
  if (isReset(cliFlag)) return undefined
  if (cliFlag !== undefined) {
    assertKnownProfile(config, cliFlag)
    return cliFlag
  }
  return config.activeProfile
}

/**
 * Return the (possibly filtered) mcpServers record that should be registered
 * for the active profile. Never mutates the input.
 *
 * - activeProfileName undefined OR config.profiles undefined → passthrough (v1.3)
 * - profile missing mcpServers field → passthrough (profile doesn't touch MCP)
 * - profile with empty array → {}
 * - profile with named servers → filtered record; missing names drop with warning
 */
export function filterMcpServersByProfile(
  config: KristosConfig,
  activeProfileName: string | undefined,
): Record<string, McpServerConfig> | undefined {
  if (activeProfileName === undefined) return config.mcpServers
  if (config.profiles === undefined) return config.mcpServers
  const profile = config.profiles[activeProfileName]
  if (profile === undefined) return config.mcpServers
  if (profile.mcpServers === undefined) return config.mcpServers

  const all = config.mcpServers ?? {}
  const out: Record<string, McpServerConfig> = {}
  for (const name of profile.mcpServers) {
    const cfg = all[name]
    if (cfg === undefined) {
      process.stderr.write(
        `[profile:${activeProfileName}] unknown mcp server '${name}' — skipping\n`,
      )
      continue
    }
    out[name] = cfg
  }
  return out
}

/**
 * Phase 23 (AGENT-04): return the (possibly filtered) cliTools record that
 * should be registered for the active profile. Mirrors
 * `filterMcpServersByProfile`. Never mutates the input.
 *
 * - activeProfileName undefined OR config.profiles undefined → passthrough
 * - profile missing cliTools field → passthrough (profile doesn't touch cli)
 * - profile with empty array → {}
 * - profile with named tools → filtered record; unknown names drop with warning
 *
 * Intentionally NOT abstracted with filterMcpServersByProfile — the two are
 * expected to diverge (per-tool metadata, trust tier overrides, etc.).
 */
export function filterCliToolsByProfile(
  config: KristosConfig,
  activeProfileName: string | undefined,
): Record<string, CliToolConfig> | undefined {
  if (activeProfileName === undefined) return config.cliTools
  if (config.profiles === undefined) return config.cliTools
  const profile = config.profiles[activeProfileName]
  if (profile === undefined) return config.cliTools
  if (profile.cliTools === undefined) return config.cliTools

  const all = config.cliTools ?? {}
  const out: Record<string, CliToolConfig> = {}
  for (const name of profile.cliTools) {
    const cfg = all[name]
    if (cfg === undefined) {
      process.stderr.write(
        `[profile:${activeProfileName}] unknown cli tool '${name}' — skipping\n`,
      )
      continue
    }
    out[name] = cfg
  }
  return out
}

/** Return profile names (empty array when config has no profiles). */
export function listProfileNames(config: KristosConfig): string[] {
  return config.profiles ? Object.keys(config.profiles) : []
}

export interface EffectiveProvider {
  provider: KristosConfig['provider']
  model: string
}

/**
 * Resolve the effective provider and model for the active profile.
 * Profile fields override top-level config; unspecified fields fall back.
 * Pure function — no I/O.
 */
export function resolveEffectiveProvider(
  config: KristosConfig,
  activeProfileName: string | undefined,
): EffectiveProvider {
  if (activeProfileName === undefined) {
    return { provider: config.provider, model: config.model }
  }
  const profile = config.profiles?.[activeProfileName]
  if (profile === undefined) {
    return { provider: config.provider, model: config.model }
  }
  return {
    provider: profile.provider ?? config.provider,
    model: profile.model ?? config.model,
  }
}
