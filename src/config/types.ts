import type { TrustTier } from '../security/trust-tiers.js'
import type { PermissionMode } from '../permissions/types.js'
import type { AgentJobConfig } from '../agent-runner/config-schema.js'
import type { DiscordConfig } from '../discord/config.js'
import type { TelegramConfig } from '../telegram/config.js'

export interface ProviderConfig {
  apiKey?: string
  baseURL?: string
  model: string
  temperature?: number
  isOllama?: boolean // enables stream:false when tools present
}

/**
 * Per-server MCP configuration (Phase 18, D-01..D-03, D-17, D-18).
 * Absent optional fields fall back to `mcpDefaults`.
 */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Working directory for the spawned child process. Useful for servers that rely on relative module imports (e.g. `python -m foo` with a project-local venv). */
  cwd?: string
  /** If true, connect at startup; otherwise lazy-connect on first tool use. */
  eagerLoad?: boolean
  /** Idle timeout before the server is shut down. Overrides mcpDefaults. */
  idleTimeoutMs?: number
  /** Default trust tier for this server's tools. Overrides mcpDefaults.trustTier. */
  trustTier?: TrustTier
  /** Per-tool trust tier overrides, keyed by bare tool name (without `mcp__` prefix). */
  toolOverrides?: Record<string, TrustTier>
  /**
   * Phase 25 (SEC-06/07): per-server sandbox configuration.
   * - `paths`: extra read-write paths to grant in the SBPL profile (in addition to cwd+tmpdir).
   *   Entries are ~-expanded and realpath-resolved; unresolvable entries are dropped with a stderr warning.
   *   No globs. No readonly variant. (D-07, D-08, D-09)
   * - `network`: opt-in network access. ONLY honored when the server's resolved trust tier is 'safe'.
   *   `risky` and `dangerous` always get network: false regardless of this field. (D-04, D-05)
   */
  sandbox?: {
    paths?: string[]
    network?: boolean
  }
}

/**
 * Global defaults applied to MCP servers that don't specify a field.
 * D-02: idleTimeoutMs default 600000 (10 min)
 * D-06/D-17: trustTier default 'dangerous' (fail-closed)
 */
export interface McpDefaults {
  idleTimeoutMs?: number
  trustTier?: TrustTier
  /**
   * Phase 19 (LEAN-03): per-server schema token budget. When a server's
   * combined tool schemas exceed this, the loader drops/compacts them.
   * Default applied at use-time: 200.
   */
  schemaBudgetTok?: number
}

/**
 * Phase 19 (LEAN-01): named profile bundling a subset of MCP servers and
 * (reserved) CLI tools. Absent `profiles` = v1.3 behavior (all configured
 * mcpServers included). `cliTools`, `provider`, `model`, and `permissionMode`
 * are typed for Phase 20 but not honored at runtime in Phase 19.
 */
/**
 * Phase 59 (ROUTE-08, D-06): Per-profile routing configuration.
 * Present only on Discord profiles. src/discord/index.ts assembles
 * RouterProvider when profile.routerConfig is defined; src/providers/registry.ts
 * never reads this field (ROUTE-06).
 *
 * Each slot references a providerConfigs entry by name. Model overrides
 * let one provider entry back multiple routing slots (e.g., classifier +
 * simple both use 'openai-compat' but classifierModel='glm-4.7-flash',
 * simpleModel='glm-4.7-flash', complexModel='glm-4.6').
 *
 * `fallbacks` wraps a sub-provider slot with FallbackProvider at assembly
 * time (D-07). Production config typically only sets fallbacks.complex.
 */
/** Phase 74 (ROUTE-01): 4-class intent classification. */
export type IntentClass = 'code' | 'research' | 'orchestration' | 'casual'

export interface RouterConfig {
  classifier: KristosConfig['provider']
  simple: KristosConfig['provider']
  complex: KristosConfig['provider']
  classifierModel?: string
  simpleModel?: string
  complexModel?: string
  /** Phase 74 (ROUTE-02): per-intent model overrides. Fall back to complexModel/simpleModel when absent. */
  codeModel?: string
  researchModel?: string
  /**
   * ROUTE-03: orchestrationModel is defined in config schema but IGNORED at routing time.
   * orchestration always routes to the strong model (complexModel) — weak models fail tool-calling.
   */
  orchestrationModel?: string
  casualModel?: string
  heuristicEnabled?: boolean      // default true
  classifierTokenCap?: number     // default 600, bounds [100, 10000]
  classifierTimeoutMs?: number    // default 2000 (Phase 59.1-02 / 999.11 lowered from 5000), bounds [500, 60000]
  /**
   * COST-05 (Phase 61): override default router-level classifier circuit breaker thresholds.
   * Defaults: failureThreshold=3, windowMs=60000, initialCooldownMs=120000, maxCooldownMs=600000.
   * When breaker opens, classifier calls short-circuit to the complex path without network cost.
   */
  classifierBreaker?: {
    failureThreshold?: number
    windowMs?: number
    initialCooldownMs?: number
    maxCooldownMs?: number
  }
  /**
   * Optional fallback providers per RouterProvider slot (D-07).
   *
   * COST-04 (Phase 61, 999.11 path 2): `fallbacks.classifier` is the
   * recommended remediation for Z.ai rate-limit windows. When set, the
   * classifier slot is wrapped with FallbackProvider (Phase 45 — 429 backoff,
   * Retry-After honouring, `provider_switch` audit). A 429 on primary then
   * routes to the fallback (typically `llamacpp` for users with a local rig)
   * instead of fail-opening the whole turn to the expensive `complex` path.
   * Recommended user config: `fallbacks: { classifier: 'llamacpp' }`.
   *
   * If the fallback provider name matches the primary slot provider name, the
   * wrap is skipped to avoid infinite fallback loops (self-fallback guard).
   */
  fallbacks?: {
    classifier?: KristosConfig['provider']
    simple?: KristosConfig['provider']
    complex?: KristosConfig['provider']
  }
}

export interface ProfileConfig {
  /** Names referencing keys in the top-level `mcpServers` map. */
  mcpServers?: string[]
  /** Reserved for Phase 20 (LEAN-02). Typed but unused in Phase 19. */
  cliTools?: string[]
  provider?: KristosConfig['provider']
  model?: string
  permissionMode?: KristosConfig['permissionMode']
  /**
   * Phase 59 (ROUTE-08): Discord-only router configuration. When present,
   * src/discord/index.ts wraps the base provider with RouterProvider before
   * the semaphore wrap. Absent = no routing on this profile.
   */
  routerConfig?: RouterConfig
  /**
   * COST-07 (Phase 61): per-profile override for context token cap.
   * Default resolved via resolveContextCap from routed model (e.g., 64k
   * Flash, 128k glm-4.6, 160k Sonnet). Set here to override for tight
   * budgets on a specific profile. Ignored outside the Discord runner.
   */
  contextTokenCap?: number
}

export interface KristosConfig {
  provider: 'anthropic' | 'openai-compat' | 'llamacpp'
  /** Fallback provider key — used when primary provider returns a transient error (401, 429, 5xx, network). */
  fallbackProvider?: 'anthropic' | 'openai-compat' | 'llamacpp'
  model: string
  windowSize: number // default 40
  permissionMode: PermissionMode // default 'yolo'
  temperature: number // default 0.7
  maxIterations: number // default 50
  toolTimeoutMs: number // default 30000
  /**
   * 0-100 percent of model context window. When reached, /compact runs
   * automatically after the next tool call completes (CTX-01).
   */
  autoCompactThreshold: number // default 90, percent
  providerConfigs: Record<string, ProviderConfig>
  /**
   * Phase 18: MCP server declarations. Undefined means "nothing configured"
   * (D-04). Replaces the legacy ~/.claude.json loader.
   */
  mcpServers?: Record<string, McpServerConfig>
  /** Phase 18: global defaults merged into each McpServerConfig at use-time. */
  mcpDefaults?: McpDefaults
  /**
   * Phase 19 (LEAN-01). Absent = all defined mcpServers included.
   * Keys are profile names; values restrict which mcpServers load.
   */
  profiles?: Record<string, ProfileConfig>
  /** Phase 19 (LEAN-01): name of the profile to activate from `profiles`. */
  activeProfile?: string
  /**
   * Phase 20 (LEAN-02): built-in CLI tool declarations. Undefined means
   * "no CLI tools registered", mirroring the `mcpServers` pattern.
   */
  cliTools?: Record<string, CliToolConfig>
  /**
   * Phase 22 (AGENT-01): headless agent job declarations. Absent means
   * "no agents configured", mirroring the `mcpServers` / `cliTools` pattern.
   * Keys are job names; values are AgentJobConfig records.
   */
  agents?: Record<string, AgentJobConfig>
  /**
   * Phase 30 (SEC-10..12, CFG-01): Discord bot configuration.
   * Absent means "Discord bot not configured".
   */
  discord?: DiscordConfig
  /**
   * Phase 69: Telegram bot configuration. When present, `tm telegram` connects
   * a grammy bot to Telegram and routes owner messages to the agent loop.
   */
  telegram?: TelegramConfig
  /**
   * Phase 46 (CTX-04): max estimated tokens for combined context files
   * (CLAUDE.md + MEMORY.md). Warns at startup when exceeded. Default 8000.
   */
  contextTokenBudget: number // default 8000
  /**
   * Phase 55 (CONC-01): process-wide cap on concurrent provider.stream() calls.
   * Prevents fan-out from subagent/orchestration flows hammering a single
   * endpoint. Range [1, 32]. Default 4.
   */
  maxInflightLLMRequests: number
  /** Phase 21 (UI-03): UI tunables. */
  ui?: {
    /** Plan 02: input area max visible lines before scroll. */
    inputMaxLines?: number
    /** Plan 04: tool result line count above which blocks collapse by default. Default 10. */
    toolOutputCollapseThreshold?: number
  }
}

/**
 * Phase 20 (LEAN-02), decision 1: config shape for a built-in CLI tool.
 * The `command` is the executable binary (looked up via PATH at spawn time).
 * `trustTier` is the default tier if no sub-command matches; absent defaults
 * to 'dangerous' (decision 10, fail-closed). `subCommandTiers` keys are
 * space-joined argv prefixes (e.g. `"pr merge"`) matched longest-first.
 */
export interface CliToolConfig {
  command: string
  description: string
  trustTier?: TrustTier
  subCommandTiers?: Record<string, TrustTier>
}

export const DEFAULT_CONFIG: KristosConfig = {
  provider: 'openai-compat',
  model: 'glm-5.1',
  windowSize: 40,
  permissionMode: 'yolo',
  temperature: 0.7,
  maxIterations: 50,
  toolTimeoutMs: 30000,
  autoCompactThreshold: 90,
  contextTokenBudget: 8000,
  maxInflightLLMRequests: 4,
  providerConfigs: {
    // GLM-5.1 cloud via Z.ai (default provider)
    'openai-compat': {
      model: 'glm-5.1',
      baseURL: 'https://api.z.ai/api/paas/v4',
    },
    anthropic: {
      model: 'claude-sonnet-4-6',
    },
    // Ready-to-use Ollama entry. Set provider: 'openai-compat' and copy this
    // under 'openai-compat' (or swap models) to activate.
    ollama: {
      model: 'qwen2.5-coder:14b',
      baseURL: 'http://localhost:11434/v1',
      isOllama: true,
    },
    // Ready-to-use llama.cpp entry. Set provider: 'llamacpp' to activate.
    // Override baseURL with your Tailscale hostname to access a remote rig:
    //   "baseURL": "http://windowsbox.tailnet-name.ts.net:8080/v1"
    llamacpp: {
      model: 'glm-4.7-flash',
      baseURL: 'http://localhost:8080/v1',
    },
  },
  // Phase 18: per D-02, D-06, D-17. No default mcpServers — undefined = unconfigured.
  mcpDefaults: {
    idleTimeoutMs: 600000,
    trustTier: 'dangerous',
  },
}
