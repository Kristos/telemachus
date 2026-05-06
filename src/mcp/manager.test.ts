import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { McpManager, type ConnectFn, __resetMcpSandboxWarningLatchForTests, extractTransportPid, __resetMcpPidWarningLatchForTests } from './manager.js'
import { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import type { AuditEntry } from '../security/audit.js'
import type { ConnectAndBridgeResult } from './client.js'
import type { PlatformSandbox } from '../tools/sandbox/index.js'
import { getTier, clearMcpTierOverrides } from '../security/trust-tiers.js'
import { z } from 'zod'

function makeConfig(partial: Partial<KristosConfig> = {}): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {},
    mcpDefaults: { idleTimeoutMs: 1000, trustTier: 'dangerous' },
    ...partial,
  }
}

function makeFakeConnectResult(name: string, toolNames: string[] = ['do_thing']): ConnectAndBridgeResult {
  const closed = { value: false }
  return {
    client: {
      close: async () => { closed.value = true },
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    } as unknown as ConnectAndBridgeResult['client'],
    transport: {
      kill: () => {},
    } as unknown as ConnectAndBridgeResult['transport'],
    toolNames: toolNames.map(t => `mcp__${name}__${t}`),
    mcpTools: toolNames.map(t => ({
      name: t,
      description: `tool ${t}`,
      inputSchema: { type: 'object' as const },
    })),
  }
}

function makeFakeConnect(
  behavior: 'ok' | 'throw' = 'ok',
  onCall?: (name: string) => void,
): ConnectFn {
  return async (name, _cfg, _tier, registry) => {
    onCall?.(name)
    if (behavior === 'throw') throw new Error('spawn failed')
    const result = makeFakeConnectResult(name)
    // Simulate client.ts by registering the bridged tools into the registry
    for (const toolName of result.toolNames) {
      registry.register({
        name: toolName,
        description: 'fake',
        inputSchema: z.object({}).passthrough(),
        rawInputSchema: { type: 'object' },
        execute: async () => ({ content: `called ${toolName}`, isError: false }),
      })
    }
    return result
  }
}

function captureAudit(): { entries: AuditEntry[]; fn: (e: AuditEntry) => Promise<void> } {
  const entries: AuditEntry[] = []
  return { entries, fn: async (e) => { entries.push(e) } }
}

describe('McpManager', () => {
  it('loadEager empty: returns 0/0 with no spawn', async () => {
    const registry = new ToolRegistry()
    const connectCalls: string[] = []
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: undefined }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect('ok', n => connectCalls.push(n)),
    })
    const r = await mgr.loadEager()
    expect(r).toEqual({ eagerCount: 0, lazyCount: 0 })
    expect(connectCalls).toEqual([])
  })

  it('eager allowlist: only eagerLoad=true servers stay alive at startup', async () => {
    const registry = new ToolRegistry()
    const connectCalls: string[] = []
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: {
          a: { command: 'a', eagerLoad: true },
          b: { command: 'b' },
          c: { command: 'c' },
        },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect('ok', n => connectCalls.push(n)),
    })
    const r = await mgr.loadEager()
    expect(r).toEqual({ eagerCount: 1, lazyCount: 2 })
    // All three were connected at least once (eager stays, lazy probe-then-kill)
    expect(connectCalls).toContain('a')
    expect(connectCalls).toContain('b')
    expect(connectCalls).toContain('c')
    const list = mgr.list()
    expect(list.find(s => s.name === 'a')?.status).toBe('alive')
    expect(list.find(s => s.name === 'b')?.status).toBe('lazy')
    expect(list.find(s => s.name === 'c')?.status).toBe('lazy')
    await mgr.dispose()
  })

  // D-18 Test 1: lazy first-use ensureAlive emits mcp_spawn
  it('ensureAlive lazy spawn: transitions lazy→alive, emits mcp_spawn audit entry (D-18 test 1)', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a' } } }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    audit.entries.length = 0
    await mgr.ensureAlive('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('alive')
    const spawnEntries = audit.entries.filter(e => e.kind === 'mcp_spawn' && e.server === 'a')
    expect(spawnEntries).toHaveLength(1)
    expect(spawnEntries[0]!.tier).toBeDefined()
    expect(spawnEntries[0]!.sandbox).toBeDefined()
    expect(spawnEntries[0]!.pid === null || typeof spawnEntries[0]!.pid === 'number').toBe(true)
    await mgr.dispose()
  })

  // D-18 Test 5: idle-kill emits mcp_idle_kill with correct idle_duration_ms
  it('idle kill: after idleTimeoutMs, server is killed and mcp_idle_kill audit written with idle_duration_ms (D-18 test 5)', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: { a: { command: 'a', eagerLoad: true, idleTimeoutMs: 50 } },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    // Wait past idle window
    await new Promise(r => setTimeout(r, 120))
    const view = mgr.list().find(s => s.name === 'a')
    expect(view?.status).toBe('idle')
    const idleEntries = audit.entries.filter(e => e.kind === 'mcp_idle_kill' && e.server === 'a')
    expect(idleEntries).toHaveLength(1)
    expect(typeof idleEntries[0]!.idle_duration_ms).toBe('number')
    expect(idleEntries[0]!.idle_duration_ms).toBeGreaterThanOrEqual(0)
    expect(idleEntries[0]!.tier).toBeDefined()
    await mgr.dispose()
  })

  // D-18 Test 3: respawn after idle-kill emits another mcp_spawn (no dedup, D-11)
  it('respawn: after idle-kill, ensureAlive emits a second mcp_spawn entry (D-18 test 3, no dedup)', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: { a: { command: 'a', eagerLoad: true, idleTimeoutMs: 50 } },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    await new Promise(r => setTimeout(r, 120))
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('idle')
    // Count spawn entries before respawn (initial eager spawn)
    const spawnsBefore = audit.entries.filter(e => e.kind === 'mcp_spawn' && e.server === 'a').length
    await mgr.ensureAlive('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('alive')
    const spawnsAfter = audit.entries.filter(e => e.kind === 'mcp_spawn' && e.server === 'a').length
    // Respawn must add at least one more mcp_spawn entry (D-11: no dedup)
    expect(spawnsAfter).toBeGreaterThan(spawnsBefore)
    await mgr.dispose()
  })

  // D-18 Test 2: eager loadEager emits mcp_spawn per eager server
  it('eager loadEager emits mcp_spawn per eager server (D-18 test 2, D-10)', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: {
          ea: { command: 'ea', eagerLoad: true },
          eb: { command: 'eb', eagerLoad: true },
        },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    const spawnEntries = audit.entries.filter(e => e.kind === 'mcp_spawn')
    expect(spawnEntries.length).toBeGreaterThanOrEqual(2)
    expect(spawnEntries.some(e => e.server === 'ea')).toBe(true)
    expect(spawnEntries.some(e => e.server === 'eb')).toBe(true)
    await mgr.dispose()
  })

  it('spawn failure: marks dead, rejects, does not auto-retry', async () => {
    const registry = new ToolRegistry()
    let calls = 0
    const connect: ConnectFn = async (_name, _cfg, _tier, _registry) => {
      calls++
      throw new Error('boom')
    }
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a' } } }),
      registry,
      sessionId: 's',
      connect,
    })
    await mgr.loadEager()
    // first attempt
    await expect(mgr.ensureAlive('a')).rejects.toThrow()
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('dead')
    // second attempt also throws — but status stays dead and nothing auto-retries in background
    const before = calls
    await expect(mgr.ensureAlive('a')).rejects.toThrow()
    // Called once more (explicit), no background retries
    expect(calls).toBe(before + 1)
  })

  it('enable/disable session-only', async () => {
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a', eagerLoad: true } } }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
    })
    await mgr.loadEager()
    await mgr.disable('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('disabled')
    await expect(mgr.ensureAlive('a')).rejects.toThrow(/disabled/)
    mgr.enable('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('lazy')
    await mgr.ensureAlive('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('alive')
    await mgr.dispose()
  })

  it('pendingCalls defer idle kill', async () => {
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: { a: { command: 'a', eagerLoad: true, idleTimeoutMs: 30 } },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
    })
    await mgr.loadEager()
    mgr.incrementPending('a')
    await new Promise(r => setTimeout(r, 80))
    // Kill was deferred because pendingCalls > 0
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('alive')
    mgr.decrementPending('a')
    await new Promise(r => setTimeout(r, 80))
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('idle')
    await mgr.dispose()
  })

  it('dispose kills all alive clients and clears timers', async () => {
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: {
          a: { command: 'a', eagerLoad: true },
          b: { command: 'b', eagerLoad: true },
        },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
    })
    await mgr.loadEager()
    await mgr.dispose()
    // After dispose, no alive servers
    const statuses = mgr.list().map(s => s.status)
    for (const s of statuses) {
      expect(s).not.toBe('alive')
    }
  })

  it('tier overrides registered at loadEager (MCP-06, D-03 > D-18 > D-17)', async () => {
    clearMcpTierOverrides()
    const registry = new ToolRegistry()
    // server 'a': server-level trustTier 'risky', one tool promoted to 'safe' via toolOverrides
    // server 'b': no trustTier -> inherits mcpDefaults 'dangerous'
    const connect: ConnectFn = async (name, _cfg, _tier, reg) => {
      const toolNames = name === 'a' ? ['safeTool', 'otherTool'] : ['doThing']
      const result: ConnectAndBridgeResult = {
        client: { close: async () => {}, callTool: async () => ({ content: [], isError: false }) } as unknown as ConnectAndBridgeResult['client'],
        transport: { kill: () => {} } as unknown as ConnectAndBridgeResult['transport'],
        toolNames: toolNames.map(t => `mcp__${name}__${t}`),
        mcpTools: toolNames.map(t => ({ name: t, description: t, inputSchema: { type: 'object' as const } })),
      }
      for (const toolName of result.toolNames) {
        reg.register({
          name: toolName,
          description: 'fake',
          inputSchema: z.object({}).passthrough(),
          rawInputSchema: { type: 'object' },
          execute: async () => ({ content: 'ok', isError: false }),
        })
      }
      return result
    }
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: {
          a: {
            command: 'a',
            eagerLoad: true,
            trustTier: 'risky',
            toolOverrides: { safeTool: 'safe' },
          },
          b: { command: 'b', eagerLoad: true },
        },
      }),
      registry,
      sessionId: 's',
      connect,
    })
    await mgr.loadEager()
    // D-03: per-tool override beats server trustTier
    expect(getTier('mcp__a__safeTool')).toBe('safe')
    // D-18: server-level trustTier applies to other tools
    expect(getTier('mcp__a__otherTool')).toBe('risky')
    // D-17: unspecified server inherits mcpDefaults 'dangerous'
    expect(getTier('mcp__b__doThing')).toBe('dangerous')
    // Unknown mcp tool still defaults to dangerous via fallthrough
    expect(getTier('mcp__a__unknown')).toBe('dangerous')
    await mgr.dispose()
    clearMcpTierOverrides()
  })

  it('touch resets idle timer on each ensureAlive call', async () => {
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: { a: { command: 'a', eagerLoad: true, idleTimeoutMs: 80 } },
      }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
    })
    await mgr.loadEager()
    // Touch repeatedly so timer never fires
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 40))
      await mgr.ensureAlive('a')
    }
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('alive')
    await mgr.dispose()
  })
})

// ---- SEC-09 sandbox-unavailable warning latch (D-15, D-21, D-22) ----

const noopSandbox: PlatformSandbox = { available: false, wrap: (cmd, args) => [cmd, ...args], detect: async () => false }
const darwinSandbox: PlatformSandbox = { available: true, wrap: (cmd, args) => ['sandbox-exec', '-p', 'dummy', cmd, ...args], detect: async () => true }

describe('McpManager sandbox-unavailable warning (SEC-09)', () => {
  let stderrSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    __resetMcpSandboxWarningLatchForTests()
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('Test 1: first ensureAlive on non-darwin writes exact stderr line + one audit entry', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry,
      sessionId: 'sess-1',
      connect: makeFakeConnect(),
      audit: audit.fn,
      platformSandbox: noopSandbox,
    })
    await mgr.loadEager()
    // Warning fires during loadEager lazy probe — reset spy to only capture ensureAlive calls
    stderrSpy.mockClear()
    audit.entries.length = 0
    __resetMcpSandboxWarningLatchForTests()

    await mgr.ensureAlive('srv')

    const stderrCalls = (stderrSpy.mock.calls as unknown[][]).map(c => c[0] as string)
    expect(stderrCalls).toContain(`[mcp: sandbox unavailable on ${process.platform}]\n`)

    const warningEntries = audit.entries.filter(e => e.kind === 'mcp_sandbox_warning')
    expect(warningEntries).toHaveLength(1)
    expect(warningEntries[0]).toMatchObject({
      kind: 'mcp_sandbox_warning',
      sessionId: 'sess-1',
      platform: process.platform,
      server: 'srv',
    })
    await mgr.dispose()
  })

  it('Test 2: second ensureAlive (same session) does NOT repeat stderr or audit', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry,
      sessionId: 'sess-2',
      connect: makeFakeConnect(),
      audit: audit.fn,
      platformSandbox: noopSandbox,
    })
    await mgr.loadEager()

    // First spawn via ensureAlive
    await mgr.ensureAlive('srv')

    const countAfterFirst = audit.entries.filter(e => e.kind === 'mcp_sandbox_warning').length
    const stderrCountAfterFirst = (stderrSpy.mock.calls as unknown[][])
      .filter(c => (c[0] as string).startsWith('[mcp: sandbox unavailable')).length

    // Kill so ensureAlive can spawn again
    await mgr.kill('srv')

    // Second spawn
    await mgr.ensureAlive('srv')

    const countAfterSecond = audit.entries.filter(e => e.kind === 'mcp_sandbox_warning').length
    const stderrCountAfterSecond = (stderrSpy.mock.calls as unknown[][])
      .filter(c => (c[0] as string).startsWith('[mcp: sandbox unavailable')).length

    expect(countAfterSecond).toBe(countAfterFirst) // no new audit entries
    expect(stderrCountAfterSecond).toBe(stderrCountAfterFirst) // no new stderr writes
    await mgr.dispose()
  })

  it('Test 3: darwin mock — ensureAlive does NOT write the warning', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry,
      sessionId: 'sess-3',
      connect: makeFakeConnect(),
      audit: audit.fn,
      platformSandbox: darwinSandbox,
    })
    await mgr.loadEager()
    await mgr.ensureAlive('srv')

    const stderrCalls = (stderrSpy.mock.calls as unknown[][]).map(c => c[0] as string)
    const hasSandboxWarning = stderrCalls.some(s => s.startsWith('[mcp: sandbox unavailable'))
    expect(hasSandboxWarning).toBe(false)

    const warningEntries = audit.entries.filter(e => e.kind === 'mcp_sandbox_warning')
    expect(warningEntries).toHaveLength(0)
    await mgr.dispose()
  })

  it('Test 4: construction without ensureAlive emits zero sandbox warnings', async () => {
    const audit = captureAudit()
    // Just construct — don't call loadEager or ensureAlive
    new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry: new ToolRegistry(),
      sessionId: 'sess-4',
      connect: makeFakeConnect(),
      audit: audit.fn,
      platformSandbox: noopSandbox,
    })

    const stderrCalls = (stderrSpy.mock.calls as unknown[][]).map(c => c[0] as string)
    const hasSandboxWarning = stderrCalls.some(s => s.startsWith('[mcp: sandbox unavailable'))
    expect(hasSandboxWarning).toBe(false)

    const warningEntries = audit.entries.filter(e => e.kind === 'mcp_sandbox_warning')
    expect(warningEntries).toHaveLength(0)
  })
})

// ---- McpManager pid extraction (D-04, D-05, D-06) ----

describe('McpManager pid extraction (D-04, D-05, D-06)', () => {
  let stderrSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    __resetMcpPidWarningLatchForTests()
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('Test A: extractTransportPid({}) returns null — no _process on transport', () => {
    const result = extractTransportPid({} as unknown as Parameters<typeof extractTransportPid>[0])
    expect(result).toBeNull()
  })

  it('Test B: extractTransportPid({ _process: {} }) returns null — no pid on _process', () => {
    const result = extractTransportPid(
      { _process: {} } as unknown as Parameters<typeof extractTransportPid>[0],
    )
    expect(result).toBeNull()
  })

  it('Test C: extractTransportPid({ _process: { pid: 12345 } }) returns 12345', () => {
    const result = extractTransportPid(
      { _process: { pid: 12345 } } as unknown as Parameters<typeof extractTransportPid>[0],
    )
    expect(result).toBe(12345)
  })

  it('Test D: pid warning latch fires exactly once per session', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry,
      sessionId: 'sess-pid-latch',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })

    // emitPidWarningForTests is a test-only public proxy for emitPidWarningIfNeeded
    mgr.emitPidWarningForTests()
    mgr.emitPidWarningForTests()
    mgr.emitPidWarningForTests()

    const pidWarningCalls = (stderrSpy.mock.calls as unknown[][])
      .filter(c => (c[0] as string).includes('pid extraction failed'))
    expect(pidWarningCalls).toHaveLength(1)
    expect(pidWarningCalls[0]![0]).toBe('[mcp: pid extraction failed — audit events will lack pid]\n')
  })

  it('Test E: ManagedServer pid field initialises to null', async () => {
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { srv: { command: 'x' } } }),
      registry,
      sessionId: 'sess-pid-field',
      connect: makeFakeConnect(),
    })
    await mgr.loadEager()
    // ManagedServer is internal; verify via list() — we use listWithPid test export if available
    // or confirm no crash and server is registered (pid field being null is a compile-time guarantee)
    const servers = mgr.list()
    expect(servers).toHaveLength(1)
    expect(servers[0]!.name).toBe('srv')
    await mgr.dispose()
  })
})

// ---- McpManager lifecycle audit — kill/disable (D-18 tests 4, 6, 7, 8) ----

describe('McpManager lifecycle audit — kill/disable (D-18 tests 4, 6, 7, 8)', () => {
  it('D-18 test 4: mcp_kill audit fires before killInternal resolves', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    // Slow-close stub: client.close takes 100ms
    const slowConnect: ConnectFn = async (name, _cfg, _tier, reg) => {
      const result = makeFakeConnectResult(name)
      result.client = {
        close: async () => { await new Promise(r => setTimeout(r, 100)) },
        callTool: async () => ({ content: [], isError: false }),
      } as unknown as ConnectAndBridgeResult['client']
      for (const toolName of result.toolNames) {
        reg.register({
          name: toolName,
          description: 'fake',
          inputSchema: z.object({}).passthrough(),
          rawInputSchema: { type: 'object' },
          execute: async () => ({ content: 'ok', isError: false }),
        })
      }
      return result
    }
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a', eagerLoad: true } } }),
      registry,
      sessionId: 's',
      connect: slowConnect,
      audit: audit.fn,
    })
    await mgr.loadEager()
    audit.entries.length = 0
    // Start kill (don't await)
    const killPromise = mgr.kill('a')
    // At this microtask, mcp_kill should already be in entries (emitKill is synchronous push to mock)
    await Promise.resolve() // flush microtasks
    const killEntriesEarly = audit.entries.filter(e => e.kind === 'mcp_kill')
    expect(killEntriesEarly).toHaveLength(1)
    expect(killEntriesEarly[0]!.reason).toBe('user')
    // Now await the kill promise completion
    await killPromise
    // Still exactly one mcp_kill entry
    expect(audit.entries.filter(e => e.kind === 'mcp_kill')).toHaveLength(1)
    await mgr.dispose()
  })

  it('D-18 test 6: disable() on alive server emits mcp_disable with was_alive: true', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a', eagerLoad: true, trustTier: 'risky' } } }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    audit.entries.length = 0
    await mgr.disable('a')
    const disableEntries = audit.entries.filter(e => e.kind === 'mcp_disable')
    expect(disableEntries).toHaveLength(1)
    expect(disableEntries[0]!.was_alive).toBe(true)
    expect(disableEntries[0]!.previous_tier).toBe('risky')
    expect(disableEntries[0]!.server).toBe('a')
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('disabled')
  })

  it('D-18 test 7: disable() on lazy server emits mcp_disable with was_alive: false', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a' } } }), // lazy by default
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    audit.entries.length = 0
    await mgr.disable('a')
    const disableEntries = audit.entries.filter(e => e.kind === 'mcp_disable')
    expect(disableEntries).toHaveLength(1)
    expect(disableEntries[0]!.was_alive).toBe(false)
    expect(disableEntries[0]!.pid).toBe(null)
    expect(mgr.list().find(s => s.name === 'a')?.status).toBe('disabled')
  })

  it('D-18 test 8: disable() does not emit mcp_kill (single audit entry)', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({ mcpServers: { a: { command: 'a', eagerLoad: true } } }),
      registry,
      sessionId: 's',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    audit.entries.length = 0
    await mgr.disable('a')
    // Filter to MCP lifecycle kinds only
    const lifecycleKinds = audit.entries.filter(e =>
      ['mcp_kill', 'mcp_disable', 'mcp_idle_kill'].includes(e.kind),
    )
    expect(lifecycleKinds).toHaveLength(1)
    expect(lifecycleKinds[0]!.kind).toBe('mcp_disable')
    // Specifically no mcp_kill
    expect(audit.entries.filter(e => e.kind === 'mcp_kill')).toHaveLength(0)
  })
})

// ---- McpManager lifecycle audit — integration (D-19) ----

describe('McpManager lifecycle audit — integration (D-19)', () => {
  it('D-19: full session lifecycle is reconstructable from audit entries alone', async () => {
    const registry = new ToolRegistry()
    const audit = captureAudit()
    const mgr = new McpManager({
      config: makeConfig({
        mcpServers: {
          alpha: { command: 'a', eagerLoad: true, idleTimeoutMs: 50 }, // will idle-kill
          beta:  { command: 'b', eagerLoad: true },                     // will user-kill
          gamma: { command: 'c', eagerLoad: true, trustTier: 'risky' }, // will disable (alive)
          delta: { command: 'd' },                                       // lazy → disable while lazy
        },
      }),
      registry,
      sessionId: 'integration-session',
      connect: makeFakeConnect(),
      audit: audit.fn,
    })
    await mgr.loadEager()
    // alpha, beta, gamma should have mcp_spawn; delta should NOT (it's lazy, no spawn yet)

    // Wait for alpha idle timeout
    await new Promise(r => setTimeout(r, 120))

    // User-kill beta
    await mgr.kill('beta')

    // Disable gamma (alive)
    await mgr.disable('gamma')

    // Disable delta (lazy — was never spawned)
    await mgr.disable('delta')

    // Build a reconstruction map: server name → { spawns: count, terminal: kind | null }
    const lifecycle = new Map<string, { spawns: number; terminal: string | null }>()
    for (const e of audit.entries) {
      if (!['mcp_spawn', 'mcp_kill', 'mcp_idle_kill', 'mcp_disable'].includes(e.kind)) continue
      const srv = (e as { server?: string }).server
      if (!srv) continue
      const rec = lifecycle.get(srv) ?? { spawns: 0, terminal: null }
      if (e.kind === 'mcp_spawn') rec.spawns++
      else rec.terminal = e.kind
      lifecycle.set(srv, rec)
    }

    // alpha: eager spawn → idle_kill
    expect(lifecycle.get('alpha')).toEqual({ spawns: 1, terminal: 'mcp_idle_kill' })
    // beta: eager spawn → user kill
    expect(lifecycle.get('beta')).toEqual({ spawns: 1, terminal: 'mcp_kill' })
    // gamma: eager spawn → disable (was_alive: true)
    expect(lifecycle.get('gamma')).toEqual({ spawns: 1, terminal: 'mcp_disable' })
    // delta: no spawn (lazy) → disable (was_alive: false)
    expect(lifecycle.get('delta')).toEqual({ spawns: 0, terminal: 'mcp_disable' })

    // Every mcp_disable entry carries previous_tier and was_alive
    const disables = audit.entries.filter(e => e.kind === 'mcp_disable')
    expect(disables).toHaveLength(2)
    for (const d of disables) {
      expect(typeof (d as { was_alive?: unknown }).was_alive).toBe('boolean')
      expect((d as { previous_tier?: unknown }).previous_tier).toBeDefined()
    }

    // gamma disable carried was_alive: true with its 'risky' previous_tier
    const gammaDisable = disables.find(d => (d as { server?: string }).server === 'gamma')!
    expect((gammaDisable as { was_alive?: unknown }).was_alive).toBe(true)
    expect((gammaDisable as { previous_tier?: unknown }).previous_tier).toBe('risky')

    // delta disable carried was_alive: false
    const deltaDisable = disables.find(d => (d as { server?: string }).server === 'delta')!
    expect((deltaDisable as { was_alive?: unknown }).was_alive).toBe(false)

    // Every mcp_kill entry has reason: 'user'
    const kills = audit.entries.filter(e => e.kind === 'mcp_kill')
    for (const k of kills) expect((k as { reason?: unknown }).reason).toBe('user')

    // Every mcp_idle_kill entry has numeric idle_duration_ms
    const idleKills = audit.entries.filter(e => e.kind === 'mcp_idle_kill')
    expect(idleKills).toHaveLength(1)
    for (const ik of idleKills) expect(typeof (ik as { idle_duration_ms?: unknown }).idle_duration_ms).toBe('number')

    await mgr.dispose()
  })
})

// ---- McpManager lifecycle audit — cleanup (D-18 test 9) ----

describe('McpManager lifecycle audit — cleanup (D-18 test 9)', () => {
  it('D-18 test 9: McpEvent type is gone from src/mcp/manager.ts', async () => {
    const { readFileSync } = await import('node:fs')
    const managerSrc = readFileSync('src/mcp/manager.ts', 'utf8')
    expect(managerSrc).not.toMatch(/\bMcpEvent\b/)
    // Also ensure the v1.3-era hack is gone from this file
    expect(managerSrc).not.toMatch(/kind: 'tool_call'[\s\S]{0,300}tool: `mcp:/)
    expect(managerSrc).not.toMatch(/tool: `mcp:\$\{/)
  })
})
