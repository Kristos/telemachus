import { describe, test, expect, spyOn } from 'bun:test'
import {
  resolveActiveProfile,
  filterMcpServersByProfile,
  listProfileNames,
  PROFILE_RESET_TOKENS,
} from '../../src/config/profile.js'
import type { KristosConfig, McpServerConfig } from '../../src/config/types.js'

function makeConfig(overrides: Partial<KristosConfig> = {}): KristosConfig {
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
    ...overrides,
  }
}

const mcp = (command: string): McpServerConfig => ({ command })

describe('resolveActiveProfile', () => {
  const config = makeConfig({
    profiles: { local: {}, cloud: {} },
    activeProfile: 'cloud',
  })

  test('sessionOverride beats cliFlag beats config.activeProfile', () => {
    expect(resolveActiveProfile(config, 'local', 'cloud')).toBe('cloud')
    expect(resolveActiveProfile(config, 'local', undefined)).toBe('local')
    expect(resolveActiveProfile(config, undefined, undefined)).toBe('cloud')
  })

  test('undefined when nothing set', () => {
    const cfg = makeConfig({ profiles: { local: {} } })
    expect(resolveActiveProfile(cfg, undefined, undefined)).toBeUndefined()
  })

  test('"default" and "reset" tokens return undefined', () => {
    expect(resolveActiveProfile(config, 'default', undefined)).toBeUndefined()
    expect(resolveActiveProfile(config, 'reset', undefined)).toBeUndefined()
    expect(resolveActiveProfile(config, undefined, 'default')).toBeUndefined()
    expect(resolveActiveProfile(config, undefined, 'reset')).toBeUndefined()
    expect(PROFILE_RESET_TOKENS.has('default')).toBe(true)
    expect(PROFILE_RESET_TOKENS.has('reset')).toBe(true)
  })

  test('unknown profile throws with available names', () => {
    expect(() => resolveActiveProfile(config, 'nope', undefined)).toThrow(/nope/)
    try {
      resolveActiveProfile(config, 'nope', undefined)
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('local')
      expect(msg).toContain('cloud')
    }
  })

  test('unknown profile throws even if no profiles configured', () => {
    const cfg = makeConfig()
    expect(() => resolveActiveProfile(cfg, 'nope', undefined)).toThrow()
  })
})

describe('filterMcpServersByProfile', () => {
  const servers = {
    a: mcp('a'),
    b: mcp('b'),
    c: mcp('c'),
  }

  test('undefined activeProfile → passthrough', () => {
    const cfg = makeConfig({ mcpServers: servers, profiles: { local: { mcpServers: ['a'] } } })
    expect(filterMcpServersByProfile(cfg, undefined)).toBe(cfg.mcpServers!)
  })

  test('no profiles field → passthrough (v1.3 compat)', () => {
    const cfg = makeConfig({ mcpServers: servers })
    expect(filterMcpServersByProfile(cfg, 'anything')).toBe(cfg.mcpServers!)
  })

  test('profile with empty mcpServers array → {}', () => {
    const cfg = makeConfig({ mcpServers: servers, profiles: { none: { mcpServers: [] } } })
    expect(filterMcpServersByProfile(cfg, 'none')).toEqual({})
  })

  test('profile without mcpServers field → passthrough', () => {
    const cfg = makeConfig({ mcpServers: servers, profiles: { x: { cliTools: ['rg'] } } })
    expect(filterMcpServersByProfile(cfg, 'x')).toBe(cfg.mcpServers!)
  })

  test('profile with named servers → filtered record', () => {
    const cfg = makeConfig({ mcpServers: servers, profiles: { local: { mcpServers: ['a', 'c'] } } })
    const filtered = filterMcpServersByProfile(cfg, 'local')
    expect(Object.keys(filtered!).sort()).toEqual(['a', 'c'])
    expect(filtered!.a).toBe(servers.a)
  })

  test('unknown server name warns to stderr and is dropped', () => {
    const spy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const cfg = makeConfig({
        mcpServers: servers,
        profiles: { local: { mcpServers: ['a', 'ghost'] } },
      })
      const filtered = filterMcpServersByProfile(cfg, 'local')
      expect(Object.keys(filtered!)).toEqual(['a'])
      const calls = spy.mock.calls.map(c => String(c[0]))
      expect(calls.some(s => s.includes('ghost') && s.includes('local'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('listProfileNames', () => {
  test('returns [] when no profiles', () => {
    expect(listProfileNames(makeConfig())).toEqual([])
  })
  test('returns keys', () => {
    const cfg = makeConfig({ profiles: { local: {}, cloud: {} } })
    expect(listProfileNames(cfg).sort()).toEqual(['cloud', 'local'])
  })
})
