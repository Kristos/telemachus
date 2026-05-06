/**
 * Phase 22 Wave 2 (AGENT-01): construct a `SubagentParent` from an
 * `AgentJobConfig` + a loaded `KristosConfig`. Pure wiring — the caller
 * supplies the Provider and ToolRegistry (so this module is testable
 * without dragging in provider construction / network).
 *
 * Profile filtering: if `jobCfg.profile` is set and the profile is unknown,
 * throws a descriptive error (via `resolveActiveProfile`). The filtered
 * `mcpServers` map is returned alongside so the runner can construct an
 * `McpManager` against the same profile view.
 */
import type { Provider } from '../providers/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'
import type { KristosConfig, McpServerConfig } from '../config/types.js'
import type { SubagentParent } from '../agent/subagent.js'
import type { AgentJobConfig } from './config-schema.js'
import { resolveActiveProfile, filterMcpServersByProfile } from '../config/profile.js'

export interface BuildParentOptions {
  provider: Provider
  registry: ToolRegistry
  /** Unique id used for audit/session correlation. */
  sessionId: string
  /** Root cwd for tool execution. Defaults to process.cwd(). */
  cwd?: string
}

export interface BuildParentResult {
  parent: SubagentParent
  /** Profile-filtered mcpServers view (undefined → passthrough all). */
  mcpServers: Record<string, McpServerConfig> | undefined
  /** Resolved profile name (undefined → no profile active). */
  activeProfile: string | undefined
}

export function buildParentFromConfig(
  jobCfg: AgentJobConfig,
  kcConfig: KristosConfig,
  opts: BuildParentOptions,
): BuildParentResult {
  // Profile resolution throws on unknown names — surface the error before
  // we build any downstream state.
  const activeProfile = resolveActiveProfile(kcConfig, jobCfg.profile, undefined)
  const mcpServers = filterMcpServersByProfile(kcConfig, activeProfile)

  const mode = jobCfg.permissionMode ?? 'agent'
  const maxIterations = jobCfg.maxIterations ?? 20

  const baseToolContext: ToolContext = {
    cwd: opts.cwd ?? process.cwd(),
    toolTimeoutMs: kcConfig.toolTimeoutMs,
    // Headless: no interactive prompts. Return empty string for any
    // ask-user-question invocation (tools should gracefully degrade).
    askUser: async () => '',
    // Agent mode bypasses permission prompts — always allow. Downstream
    // audit entries still carry `mode: 'agent'` via the field below so
    // operators can filter the audit log.
    checkPermission: async () => 'allow',
    sessionId: opts.sessionId,
    mode,
    originalCwd: opts.cwd ?? process.cwd(),
  }

  // Wire subagentParent so the built-in `task` tool works from inside a
  // headless agent job (previously it errored "task tool requires
  // subagentParent in ToolContext"). Single level of nesting — the spawned
  // subagent deliberately doesn't get its own subagentParent, preventing
  // recursive nesting. Mirrors the TUI pattern in src/ui/app.tsx.
  const toolContext: ToolContext = {
    ...baseToolContext,
    subagentParent: {
      provider: opts.provider,
      registry: opts.registry,
      apiSchemas: opts.registry.toAPISchema(),
      toolContext: baseToolContext,
      temperature: kcConfig.temperature,
      windowSize: kcConfig.windowSize,
      maxIterations,
    },
  }

  const parent: SubagentParent = {
    provider: opts.provider,
    registry: opts.registry,
    apiSchemas: opts.registry.toAPISchema(),
    toolContext,
    temperature: kcConfig.temperature,
    windowSize: kcConfig.windowSize,
    maxIterations,
  }

  return { parent, mcpServers, activeProfile }
}
