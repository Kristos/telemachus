import type { Tool } from '../tools/types.js'
import type { KristosConfig, CliToolConfig } from '../config/types.js'
import type { TrustTier } from '../security/trust-tiers.js'
import { setCliTierOverrides } from '../security/trust-tiers.js'
import { buildCliTool } from './build-tool.js'

/**
 * Exported set of registered CLI tool names. The agent loop consults this
 * to route cli:<name> tools through the CLI-specific audit + permission path
 * (resolved sub-command tier, clean command summary) instead of the default
 * tool flow. Populated by registerCliTools; cleared on re-register.
 */
export const registeredCliToolNames: Set<string> = new Set()

/**
 * Exported configs keyed by tool name — the loop needs these to validate args
 * and resolve the sub-command tier *before* the permission gate (decision 9:
 * permission prompt shows resolved sub-command, not full arg string).
 */
export const registeredCliToolConfigs: Map<string, CliToolConfig> = new Map()

function isValidCliToolConfig(value: unknown): value is CliToolConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.command === 'string' && typeof v.description === 'string'
}

/**
 * Phase 20 (LEAN-02): turn `config.cliTools` into model-visible Tools and
 * register `cli:<name>` trust tier overrides as a side effect.
 *
 * Invalid entries (missing `command` or `description`) are skipped with a
 * stderr warning — a single bad entry must not crash the agent. Decision 6
 * and decision 10: default tier is 'dangerous' (fail-closed).
 */
export function registerCliTools(config: KristosConfig): Tool[] {
  const entries = config.cliTools ?? {}
  const tools: Tool[] = []
  const overrides: Record<string, TrustTier> = {}

  // Reset the registry — repeat calls replace previous registrations
  registeredCliToolNames.clear()
  registeredCliToolConfigs.clear()

  for (const [name, cfg] of Object.entries(entries)) {
    if (!isValidCliToolConfig(cfg)) {
      console.error(
        `[cli-tools] skipping invalid entry '${name}': missing command or description`
      )
      continue
    }
    tools.push(buildCliTool(name, cfg))
    overrides[`cli:${name}`] = cfg.trustTier ?? 'dangerous'
    registeredCliToolNames.add(name)
    registeredCliToolConfigs.set(name, cfg)
  }

  if (tools.length > 0) {
    setCliTierOverrides(overrides)
  }

  return tools
}
