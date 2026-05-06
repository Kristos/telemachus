import { describe, test, expect } from 'bun:test'
import { McpManager, unregisterAllMcpTools, type ConnectFn } from '../../src/mcp/manager.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import type { KristosConfig } from '../../src/config/types.js'
import { filterMcpServersByProfile, resolveActiveProfile } from '../../src/config/profile.js'

function baseConfig(): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    providerConfigs: {},
    mcpServers: {
      a: { command: 'a' },
      b: { command: 'b' },
      c: { command: 'c' },
    },
    profiles: {
      local: { mcpServers: ['a'] },
      full: { mcpServers: ['a', 'b', 'c'] },
    },
    activeProfile: 'full',
  }
}

/** Stub connect function: registers one bridged tool named mcp__<server>__ping. */
function makeStubConnect(): ConnectFn {
  const connect: ConnectFn = async (name, _cfg, _tier, registry) => {
    const toolName = `mcp__${name}__ping`
    registry.register({
      name: toolName,
      description: `stub ${name} tool`,
      inputSchema: { parse: (x: unknown) => x } as never,
      execute: async () => ({ content: 'ok', isError: false }),
    })
    return {
      client: { close: async () => {} } as never,
      transport: {} as never,
      toolNames: [toolName],
      mcpTools: [{ name: 'ping', inputSchema: { type: 'object' } }],
    }
  }
  return connect
}

function mcpToolNames(registry: ToolRegistry): string[] {
  return registry
    .getAll()
    .map(t => t.name)
    .filter(n => n.startsWith('mcp__'))
    .sort()
}

// Force eager on all servers so the connect stub runs for each during loadEager.
function eagerify(cfg: KristosConfig): KristosConfig {
  const servers = Object.fromEntries(
    Object.entries(cfg.mcpServers ?? {}).map(([n, s]) => [n, { ...s, eagerLoad: true }]),
  )
  return { ...cfg, mcpServers: servers }
}

describe('McpManager profile filtering', () => {
  test('loads only profile-named servers when started with --profile local', async () => {
    const original = eagerify(baseConfig())
    const active = resolveActiveProfile(original, 'local', undefined)
    const filtered = filterMcpServersByProfile(original, active)
    const effective: KristosConfig = { ...original, mcpServers: filtered }

    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: effective,
      registry,
      sessionId: 'test',
      connect: makeStubConnect(),
      audit: async () => {},
    })
    await mgr.loadEager()

    expect(mcpToolNames(registry)).toEqual(['mcp__a__ping'])
    expect(mgr.list().map(v => v.name).sort()).toEqual(['a'])
    await mgr.dispose()
  })

  test('reloadForProfile switches from local → full → reset → unknown', async () => {
    const original = eagerify(baseConfig())
    // Start with 'local'
    const firstActive = resolveActiveProfile(original, 'local', undefined)
    const firstFiltered = filterMcpServersByProfile(original, firstActive)
    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: { ...original, mcpServers: firstFiltered },
      registry,
      sessionId: 'test',
      connect: makeStubConnect(),
      audit: async () => {},
    })
    await mgr.loadEager()
    expect(mcpToolNames(registry)).toEqual(['mcp__a__ping'])

    // Switch to 'full'
    await mgr.reloadForProfile(original, 'full')
    expect(mcpToolNames(registry)).toEqual([
      'mcp__a__ping',
      'mcp__b__ping',
      'mcp__c__ping',
    ])

    // Reset via undefined — falls back to config.activeProfile (which is 'full')
    await mgr.reloadForProfile(original, undefined)
    expect(mcpToolNames(registry)).toEqual([
      'mcp__a__ping',
      'mcp__b__ping',
      'mcp__c__ping',
    ])

    // Back to 'local'
    await mgr.reloadForProfile(original, 'local')
    expect(mcpToolNames(registry)).toEqual(['mcp__a__ping'])

    // Unknown profile throws, prior state preserved
    await expect(mgr.reloadForProfile(original, 'ghost')).rejects.toThrow(/ghost/)
    expect(mcpToolNames(registry)).toEqual(['mcp__a__ping'])

    await mgr.dispose()
  })

  test('v1.3 config (no profiles field) is unchanged by filtering', async () => {
    const cfg = eagerify({ ...baseConfig(), profiles: undefined, activeProfile: undefined })
    const active = resolveActiveProfile(cfg, undefined, undefined)
    const filtered = filterMcpServersByProfile(cfg, active)
    expect(filtered).toBe(cfg.mcpServers)

    const registry = new ToolRegistry()
    const mgr = new McpManager({
      config: { ...cfg, mcpServers: filtered },
      registry,
      sessionId: 'test',
      connect: makeStubConnect(),
      audit: async () => {},
    })
    await mgr.loadEager()
    expect(mcpToolNames(registry).length).toBe(3)
    await mgr.dispose()
  })

  test('unregisterAllMcpTools removes only mcp__* tools', () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'file_read',
      description: 'x',
      inputSchema: { parse: (x: unknown) => x } as never,
      execute: async () => ({ content: '', isError: false }),
    })
    registry.register({
      name: 'mcp__foo__bar',
      description: 'x',
      inputSchema: { parse: (x: unknown) => x } as never,
      execute: async () => ({ content: '', isError: false }),
    })
    unregisterAllMcpTools(registry)
    expect(registry.getAll().map(t => t.name)).toEqual(['file_read'])
  })
})
