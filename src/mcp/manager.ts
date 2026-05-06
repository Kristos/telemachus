import type { ToolRegistry } from '../tools/registry.js'
import type { Tool, ToolResult } from '../tools/types.js'
import type { KristosConfig, McpServerConfig } from '../config/types.js'
import { setMcpTierOverrides, type TrustTier } from '../security/trust-tiers.js'
import { appendAuditEntry, type AuditEntry } from '../security/audit.js'
import { connectAndBridge as defaultConnectAndBridge, type ConnectAndBridgeResult } from './client.js'
import type { McpServerStatus } from './types.js'
import { filterMcpServersByProfile, resolveActiveProfile } from '../config/profile.js'
import { getPlatformSandbox, type PlatformSandbox } from '../tools/sandbox/index.js'
import { z } from 'zod'

// D-15, D-22: latched once per session. Never reset within a process.
// Exported only for test reset via a test-only helper.
let mcpSandboxWarningEmitted = false
/** TEST-ONLY: reset the module-level sandbox warning latch. */
export function __resetMcpSandboxWarningLatchForTests(): void {
  mcpSandboxWarningEmitted = false
}

// D-06: latched once per session. Fires stderr diagnostic when pid extraction fails.
// Exported only for test reset via a test-only helper.
let mcpPidWarningEmitted = false
/** TEST-ONLY: reset the module-level pid-extraction warning latch. */
export function __resetMcpPidWarningLatchForTests(): void {
  mcpPidWarningEmitted = false
}

/**
 * D-05: Extract the OS pid from a StdioClientTransport's internal _process field.
 * Returns null without throwing when the field is absent (e.g. test fakes, custom transports).
 * TEST-ONLY export — call sites in 26-02 will access this directly.
 */
export function extractTransportPid(transport: ConnectAndBridgeResult['transport']): number | null {
  const inner = (transport as unknown as { _process?: { pid?: number } })._process
  return inner?.pid ?? null
}

/**
 * Unregister every MCP-bridged tool (names starting with `mcp__`) from the
 * registry. Used by reloadForProfile when swapping profiles at runtime so
 * excluded servers' tools disappear from the LLM manifest.
 */
export function unregisterAllMcpTools(registry: ToolRegistry): void {
  for (const tool of registry.getAll()) {
    if (tool.name.startsWith('mcp__')) {
      registry.unregister(tool.name)
    }
  }
}

export type ConnectFn = (
  name: string,
  cfg: McpServerConfig,
  resolvedTier: TrustTier,
  registry: ToolRegistry,
) => Promise<ConnectAndBridgeResult>

export interface McpManagerOptions {
  config: KristosConfig
  registry: ToolRegistry
  sessionId: string
  /** Injectable for tests. Defaults to real connectAndBridge. */
  connect?: ConnectFn
  /** Injectable for tests; defaults to real appendAuditEntry. */
  audit?: (entry: AuditEntry) => Promise<void>
  /** Current permission mode for audit entries. */
  mode?: string
  /** Injectable for tests; defaults to getPlatformSandbox(). Used for sandbox availability check. */
  platformSandbox?: PlatformSandbox
}

export interface ManagedServerView {
  name: string
  mode: 'eager' | 'lazy'
  status: McpServerStatus
  lastActivity: number | null
  toolCount: number
  trustTier: TrustTier
}

interface ManagedServer {
  name: string
  cfg: McpServerConfig
  mode: 'eager' | 'lazy'
  status: McpServerStatus
  bridgedToolNames: string[]
  /** Metadata captured from first probe (eager-list-then-kill) so we can re-bridge after respawn. */
  knownToolMeta: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  client?: ConnectAndBridgeResult['client']
  transport?: ConnectAndBridgeResult['transport']
  pid: number | null    // D-04: OS pid from transport._process.pid; null until extracted in 26-02
  lastActivity: number | null
  idleTimer: ReturnType<typeof setTimeout> | null
  pendingCalls: number
  killing: boolean
  trustTier: TrustTier
  idleTimeoutMs: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000
const DEFAULT_TRUST_TIER: TrustTier = 'dangerous'

export class McpManager {
  private servers = new Map<string, ManagedServer>()
  private config: KristosConfig
  private readonly registry: ToolRegistry
  private readonly sessionId: string
  private readonly connect: ConnectFn
  private readonly auditFn: (entry: AuditEntry) => Promise<void>
  private readonly mode: string
  private readonly platformSandbox: PlatformSandbox
  private disposed = false

  constructor(opts: McpManagerOptions) {
    this.config = opts.config
    this.registry = opts.registry
    this.sessionId = opts.sessionId
    this.connect = opts.connect ?? defaultConnectAndBridge
    this.auditFn = opts.audit ?? appendAuditEntry
    this.mode = opts.mode ?? 'ask'
    this.platformSandbox = opts.platformSandbox ?? getPlatformSandbox()
  }

  // ---- Public API ------------------------------------------------------

  async loadEager(): Promise<{ eagerCount: number; lazyCount: number }> {
    const entries = Object.entries(this.config.mcpServers ?? {})
    if (entries.length === 0) return { eagerCount: 0, lazyCount: 0 }

    const defaults = this.config.mcpDefaults ?? {}
    let eagerCount = 0
    let lazyCount = 0

    for (const [name, rawCfg] of entries) {
      const cfg: McpServerConfig = { ...rawCfg }
      const idleTimeoutMs = cfg.idleTimeoutMs ?? defaults.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
      const trustTier = cfg.trustTier ?? defaults.trustTier ?? DEFAULT_TRUST_TIER

      const managed: ManagedServer = {
        name,
        cfg,
        mode: cfg.eagerLoad === true ? 'eager' : 'lazy',
        status: 'lazy',
        bridgedToolNames: [],
        knownToolMeta: [],
        pid: null,        // D-04: set to null at registration; wired in 26-02
        lastActivity: null,
        idleTimer: null,
        pendingCalls: 0,
        killing: false,
        trustTier,
        idleTimeoutMs,
      }
      this.servers.set(name, managed)

      if (managed.mode === 'eager') {
        try {
          this.emitSandboxWarningIfNeeded(name)
          const result = await this.connect(name, cfg, trustTier, this.registry)
          managed.client = result.client
          managed.transport = result.transport
          managed.bridgedToolNames = result.toolNames
          managed.knownToolMeta = result.mcpTools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          }))
          managed.status = 'alive'
          managed.pid = extractTransportPid(result.transport)
          if (managed.pid === null) this.emitPidWarningIfNeeded()
          this.touch(name)
          this.emitSpawn(managed)
          eagerCount++
        } catch (err) {
          managed.status = 'dead'
          eagerCount++
          // Surface spawn failures to stderr so headless/agent runs don't
          // silently ship with an empty MCP tool manifest. Dogfood during
          // Phase 24 revealed that silent failures here produced model
          // runs that believed tools were "not available" without ever
          // logging why.
          process.stderr.write(
            `[mcp] ${name} eager spawn failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      } else {
        // Lazy: eager-list-then-kill (RESEARCH §"Lazy stub strategy" option 2)
        try {
          this.emitSandboxWarningIfNeeded(name)
          const probe = await this.connect(name, cfg, trustTier, this.registry)
          managed.knownToolMeta = probe.mcpTools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          }))
          // Unregister real bridged tools and replace with lazy wrappers
          for (const toolName of probe.toolNames) {
            this.registry.unregister(toolName)
          }
          // Kill the probe client immediately
          try {
            await probe.client.close()
          } catch {}
          // Register lazy wrappers that ensureAlive() on call
          this.registerLazyWrappers(managed)
          managed.status = 'lazy'
          lazyCount++
        } catch (err) {
          // Probe failed — still register as lazy with no known tools; mark dead
          managed.status = 'dead'
          lazyCount++
          process.stderr.write(
            `[mcp] ${name} lazy probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    }

    // Register resolved per-tool trust tier overrides (D-03 beats D-18 beats
    // D-17 default). Done once at the end of loadEager so the tiers are known
    // before any tool call or permission prompt (D-19).
    this.refreshTierOverrides()

    return { eagerCount, lazyCount }
  }

  /**
   * Build a flat `mcp__<server>__<tool> → TrustTier` map from the current
   * managed servers and publish it via setMcpTierOverrides. Resolution order:
   *   toolOverrides[tool] > server.trustTier > mcpDefaults.trustTier > 'dangerous'
   */
  private refreshTierOverrides(): void {
    const overrides: Record<string, TrustTier> = {}
    for (const srv of this.servers.values()) {
      const serverTier = srv.trustTier
      const perTool = srv.cfg.toolOverrides ?? {}
      // Iterate over the known bridged tool names (both live-bridged and
      // lazy-known — knownToolMeta carries bare tool names).
      for (const meta of srv.knownToolMeta) {
        const fullName = `mcp__${srv.name}__${meta.name}`
        overrides[fullName] = perTool[meta.name] ?? serverTier
      }
      for (const fullName of srv.bridgedToolNames) {
        if (fullName in overrides) continue
        const bare = fullName.replace(`mcp__${srv.name}__`, '')
        overrides[fullName] = perTool[bare] ?? serverTier
      }
    }
    setMcpTierOverrides(overrides)
  }

  async ensureAlive(name: string): Promise<void> {
    const srv = this.servers.get(name)
    if (!srv) throw new Error(`Unknown MCP server: ${name}`)
    if (srv.status === 'disabled') throw new Error(`MCP server '${name}' is disabled`)
    if (srv.status === 'alive') {
      this.touch(name)
      return
    }

    const wasIdle = srv.status === 'idle'
    // D-22: warning fires on FIRST MCP spawn attempt, not at construction/startup.
    this.emitSandboxWarningIfNeeded(name)
    try {
      const result = await this.connect(name, srv.cfg, srv.trustTier, this.registry)
      srv.client = result.client
      srv.transport = result.transport
      srv.bridgedToolNames = result.toolNames
      srv.knownToolMeta = result.mcpTools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }))
      srv.status = 'alive'
      srv.killing = false
      srv.pid = extractTransportPid(result.transport)
      if (srv.pid === null) this.emitPidWarningIfNeeded()
      this.touch(name)
      this.emitSpawn(srv)
    } catch (err) {
      srv.status = 'dead'
      throw err
    }
  }

  async spawn(name: string): Promise<void> {
    const srv = this.servers.get(name)
    if (!srv) throw new Error(`Unknown MCP server: ${name}`)
    srv.status = 'lazy' // reset so ensureAlive will spawn
    await this.ensureAlive(name)
  }

  async kill(name: string): Promise<void> {
    const srv = this.servers.get(name)
    if (!srv) return
    // D-02: emit BEFORE killInternal so audit write is initiated before SIGTERM
    this.emitKill(srv, 'user')
    await this.killInternal(srv)
  }

  enable(name: string): void {
    const srv = this.servers.get(name)
    if (!srv) return
    if (srv.status === 'disabled') {
      srv.status = 'lazy'
    }
  }

  async disable(name: string): Promise<void> {
    const srv = this.servers.get(name)
    if (!srv) return
    // D-08: capture wasAlive + pid BEFORE any state changes
    const wasAlive = srv.status === 'alive'
    const pid = srv.pid
    // D-07: exactly ONE mcp_disable event — no separate mcp_kill
    this.emitDisable(srv, wasAlive, pid)
    if (wasAlive) {
      await this.killInternal(srv)
    }
    srv.status = 'disabled'
  }

  list(): ManagedServerView[] {
    return [...this.servers.values()].map(s => ({
      name: s.name,
      mode: s.mode,
      status: s.status,
      lastActivity: s.lastActivity,
      toolCount: s.bridgedToolNames.length || s.knownToolMeta.length,
      trustTier: s.trustTier,
    }))
  }

  touch(name: string): void {
    const srv = this.servers.get(name)
    if (!srv) return
    srv.lastActivity = Date.now()
    if (srv.idleTimer) {
      clearTimeout(srv.idleTimer)
      srv.idleTimer = null
    }
    if (srv.status !== 'alive') return
    const timer = setTimeout(() => {
      void this.killForIdle(srv.name)
    }, srv.idleTimeoutMs)
    // Don't let the idle timer hold the process open (RESEARCH risk #3).
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    srv.idleTimer = timer
  }

  incrementPending(name: string): void {
    const srv = this.servers.get(name)
    if (srv) srv.pendingCalls++
  }

  decrementPending(name: string): void {
    const srv = this.servers.get(name)
    if (srv && srv.pendingCalls > 0) srv.pendingCalls--
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const all = [...this.servers.values()]
    for (const srv of all) {
      if (srv.idleTimer) {
        clearTimeout(srv.idleTimer)
        srv.idleTimer = null
      }
    }
    await Promise.allSettled(all.map(s => this.killInternal(s, true)))
  }

  /**
   * Phase 19 (LEAN-01): swap the active profile at runtime. Disposes all
   * currently managed servers, clears every `mcp__*` tool from the registry,
   * re-filters the originalConfig via the new profile name, and rebuilds.
   *
   * `profileName === undefined` means "fall back to config.activeProfile".
   * Throws (preserving prior state) when the profile name is unknown — we
   * validate BEFORE tearing anything down.
   */
  async reloadForProfile(
    originalConfig: KristosConfig,
    profileName: string | undefined,
  ): Promise<void> {
    // Validate first so we don't destroy state on a typo. resolveActiveProfile
    // throws on unknown names.
    const active = resolveActiveProfile(originalConfig, profileName, undefined)
    const filtered = filterMcpServersByProfile(originalConfig, active)

    // Tear down every currently-managed server (best-effort, same as dispose
    // but without flipping the disposed flag so the manager stays usable).
    const existing = [...this.servers.values()]
    for (const srv of existing) {
      if (srv.idleTimer) {
        clearTimeout(srv.idleTimer)
        srv.idleTimer = null
      }
    }
    await Promise.allSettled(existing.map(s => this.killInternal(s, true)))

    // Clear all MCP-bridged tools from the registry, then wipe the managed
    // server map so loadEager rebuilds from scratch.
    unregisterAllMcpTools(this.registry)
    this.servers.clear()

    // Swap in the filtered config and rebuild.
    this.config = { ...originalConfig, mcpServers: filtered }
    await this.loadEager()
  }

  // ---- Internal --------------------------------------------------------

  /** D-06: emit once-per-session warning when pid extraction fails. Stderr diagnostic only — no audit entry. */
  private emitPidWarningIfNeeded(): void {
    if (mcpPidWarningEmitted) return
    mcpPidWarningEmitted = true
    process.stderr.write(`[mcp: pid extraction failed — audit events will lack pid]\n`)
  }

  /** TEST-ONLY: public proxy for emitPidWarningIfNeeded so tests can exercise the latch. */
  emitPidWarningForTests(): void { this.emitPidWarningIfNeeded() }

  /** D-15, D-21, D-22: emit once-per-session warning when sandbox is unavailable. */
  private emitSandboxWarningIfNeeded(serverName: string): void {
    if (mcpSandboxWarningEmitted) return
    if (this.platformSandbox.available) return
    mcpSandboxWarningEmitted = true
    // Literal format per D-21
    process.stderr.write(`[mcp: sandbox unavailable on ${process.platform}]\n`)
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_sandbox_warning',
      sessionId: this.sessionId,
      platform: process.platform,
      server: serverName,
    }
    void this.auditFn(entry).catch(() => {})
  }

  private async killForIdle(name: string): Promise<void> {
    const srv = this.servers.get(name)
    if (!srv || srv.status !== 'alive') return
    if (srv.pendingCalls > 0) {
      // Defer idle kill until no in-flight calls (RESEARCH risk #2).
      this.touch(name)
      return
    }
    // D-14: capture pid and idle_duration BEFORE killInternal (which clears transport/pid).
    const pid = srv.pid
    const idleDurationMs = Date.now() - (srv.lastActivity ?? Date.now())
    await this.killInternal(srv)
    srv.status = 'idle'
    // D-14: emit AFTER killInternal returns.
    this.emitIdleKill(srv, pid, idleDurationMs)
  }

  private async killInternal(srv: ManagedServer, skipAudit = false): Promise<void> {
    if (srv.killing) return
    srv.killing = true
    if (srv.idleTimer) {
      clearTimeout(srv.idleTimer)
      srv.idleTimer = null
    }
    const client = srv.client
    const transport = srv.transport
    // Unregister bridged tools so they don't leak between respawns
    for (const toolName of srv.bridgedToolNames) {
      this.registry.unregister(toolName)
    }
    srv.bridgedToolNames = []
    // If this was a lazy server, re-register lazy wrappers after kill
    const reregisterLazy = srv.mode === 'lazy' && !skipAudit

    if (client) {
      try {
        await Promise.race([
          client.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('kill grace timeout')), 2000),
          ),
        ])
      } catch {
        try {
          const t = transport as unknown as { kill?: (sig: string) => void }
          if (t && typeof t.kill === 'function') t.kill('SIGKILL')
        } catch {}
      }
    }
    srv.client = undefined
    srv.transport = undefined
    srv.pid = null
    // Mark as idle/lazy by default; callers (killForIdle, disable) override.
    if (srv.status === 'alive') {
      srv.status = srv.mode === 'lazy' ? 'lazy' : 'idle'
    }
    if (reregisterLazy && this.servers.has(srv.name)) {
      this.registerLazyWrappers(srv)
    }
    srv.killing = false
  }

  private registerLazyWrappers(srv: ManagedServer): void {
    // Build wrapper Tools that call ensureAlive, then delegate to the now-alive bridged tool.
    for (const meta of srv.knownToolMeta) {
      const fullName = `mcp__${srv.name}__${meta.name}`
      const wrapper: Tool = {
        name: fullName,
        description: meta.description ?? `MCP tool from ${srv.name}`,
        inputSchema: z.object({}).passthrough(),
        rawInputSchema: meta.inputSchema,
        execute: async (args: unknown): Promise<ToolResult> => {
          try {
            await this.ensureAlive(srv.name)
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            return { content: `MCP server '${srv.name}' unavailable: ${errMsg}`, isError: true }
          }
          const live = this.registry.find(fullName)
          if (!live || live === wrapper) {
            return { content: `MCP tool '${fullName}' not found after spawn`, isError: true }
          }
          this.incrementPending(srv.name)
          try {
            return await live.execute(args, {
              cwd: process.cwd(),
              toolTimeoutMs: 30000,
              askUser: async () => '',
            })
          } finally {
            this.decrementPending(srv.name)
            this.touch(srv.name)
          }
        },
      }
      this.registry.register(wrapper)
    }
  }

  /** D-09, D-10, D-11: fire-and-forget mcp_spawn. Every spawn (including respawn) emits — no dedup. */
  private emitSpawn(srv: ManagedServer): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_spawn',
      sessionId: this.sessionId,
      platform: process.platform,
      server: srv.name,
      pid: srv.pid,
      tier: srv.trustTier,
      sandbox: this.platformSandbox.available ? 'enforced' : 'unavailable',
    }
    void this.auditFn(entry).catch(() => {})
  }

  /** D-12, D-13, D-14: fire-and-forget mcp_idle_kill. Caller must pass pid captured BEFORE killInternal. */
  private emitIdleKill(srv: ManagedServer, pid: number | null, idleDurationMs: number): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_idle_kill',
      sessionId: this.sessionId,
      platform: process.platform,
      server: srv.name,
      pid,
      tier: srv.trustTier,
      idle_duration_ms: idleDurationMs,
    }
    void this.auditFn(entry).catch(() => {})
  }

  /** D-02, D-03: fire-and-forget mcp_kill. Caller MUST call this IMMEDIATELY BEFORE await killInternal. */
  private emitKill(srv: ManagedServer, reason: 'user'): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_kill',
      sessionId: this.sessionId,
      platform: process.platform,
      server: srv.name,
      pid: srv.pid,
      tier: srv.trustTier,
      reason,
    }
    void this.auditFn(entry).catch(() => {})
  }

  /** D-07, D-08: fire-and-forget mcp_disable. Caller captures wasAlive+pid BEFORE killInternal. */
  private emitDisable(srv: ManagedServer, wasAlive: boolean, pid: number | null): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_disable',
      sessionId: this.sessionId,
      platform: process.platform,
      server: srv.name,
      previous_tier: srv.trustTier,
      was_alive: wasAlive,
      pid,
    }
    void this.auditFn(entry).catch(() => {})
  }
}
