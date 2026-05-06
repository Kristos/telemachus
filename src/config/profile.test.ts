/**
 * Phase 23-01 (AGENT-04): filterCliToolsByProfile unit + integration tests.
 *
 * Mirrors the 5 must-have truths from the plan: passthrough when no profile,
 * passthrough when profile has no cliTools field, empty filter, named filter,
 * and unknown-name warning (stderr, non-crashing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { filterCliToolsByProfile, filterMcpServersByProfile, resolveEffectiveProvider } from './profile.js'
import type { KristosConfig, CliToolConfig } from './types.js'
import { buildAllTools } from '../tools/builtin/index.js'

function baseCliTools(): Record<string, CliToolConfig> {
  return {
    gh: { command: 'gh', description: 'github cli' },
    jq: { command: 'jq', description: 'json query' },
    fd: { command: 'fd', description: 'find' },
  }
}

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
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: { anthropic: { model: 'claude-sonnet-4-6' } },
    cliTools: baseCliTools(),
    ...overrides,
  }
}

describe('filterCliToolsByProfile', () => {
  let stderrCalls: string[]
  let originalWrite: typeof process.stderr.write

  beforeEach(() => {
    stderrCalls = []
    originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as unknown as typeof process.stderr.write
  })

  afterEach(() => {
    process.stderr.write = originalWrite
  })

  it('passthrough when activeProfileName is undefined', () => {
    const cfg = makeConfig()
    const result = filterCliToolsByProfile(cfg, undefined)
    expect(result).toBe(cfg.cliTools)
  })

  it('passthrough when config.profiles is undefined', () => {
    const cfg = makeConfig({ profiles: undefined })
    const result = filterCliToolsByProfile(cfg, 'local')
    expect(result).toBe(cfg.cliTools)
  })

  it('passthrough when profile has no cliTools field', () => {
    const cfg = makeConfig({
      profiles: { local: { mcpServers: ['x'] } },
    })
    const result = filterCliToolsByProfile(cfg, 'local')
    expect(result).toBe(cfg.cliTools)
  })

  it('returns empty object when profile.cliTools is []', () => {
    const cfg = makeConfig({
      profiles: { local: { cliTools: [] } },
    })
    const result = filterCliToolsByProfile(cfg, 'local')
    expect(result).toEqual({})
  })

  it('filters to named cliTools only', () => {
    const cfg = makeConfig({
      profiles: { local: { cliTools: ['gh'] } },
    })
    const result = filterCliToolsByProfile(cfg, 'local')
    expect(Object.keys(result ?? {})).toEqual(['gh'])
    expect(result?.gh).toBeDefined()
    expect(result?.jq).toBeUndefined()
  })

  it('drops unknown cli tool names with a stderr warning', () => {
    const cfg = makeConfig({
      profiles: { local: { cliTools: ['gh', 'nope'] } },
    })
    const result = filterCliToolsByProfile(cfg, 'local')
    expect(Object.keys(result ?? {})).toEqual(['gh'])
    const joined = stderrCalls.join('')
    expect(joined).toContain("[profile:local] unknown cli tool 'nope'")
    expect(joined).toContain('skipping')
  })

  it('does not mutate the input config.cliTools map', () => {
    const cfg = makeConfig({
      profiles: { local: { cliTools: ['gh'] } },
    })
    const before = { ...cfg.cliTools }
    filterCliToolsByProfile(cfg, 'local')
    expect(cfg.cliTools).toEqual(before)
    expect(Object.keys(cfg.cliTools ?? {})).toEqual(['gh', 'jq', 'fd'])
  })
})

describe('filterCliToolsByProfile integration with buildAllTools', () => {
  it('buildAllTools receives filtered cliTools under active profile', () => {
    const cfg = makeConfig({
      profiles: { local: { cliTools: ['gh'] } },
    })
    const filteredCliTools = filterCliToolsByProfile(cfg, 'local')
    const filteredMcp = filterMcpServersByProfile(cfg, 'local')
    const filteredCfg = { ...cfg, mcpServers: filteredMcp, cliTools: filteredCliTools }

    const tools = buildAllTools(filteredCfg)
    const names = tools.map((t) => t.name)
    expect(names).toContain('gh')
    expect(names).not.toContain('jq')
    expect(names).not.toContain('fd')
  })

  it('buildAllTools passthrough when no active profile — all cliTools present', () => {
    const cfg = makeConfig()
    const filteredCliTools = filterCliToolsByProfile(cfg, undefined)
    const filteredCfg = { ...cfg, cliTools: filteredCliTools }

    const tools = buildAllTools(filteredCfg)
    const names = tools.map((t) => t.name)
    expect(names).toContain('gh')
    expect(names).toContain('jq')
    expect(names).toContain('fd')
  })
})

describe('resolveEffectiveProvider', () => {
  it('profile with provider and model returns both from profile', () => {
    const cfg = makeConfig({
      profiles: { local: { provider: 'llamacpp', model: 'glm-4.7-flash' } },
      providerConfigs: {
        anthropic: { model: 'claude-sonnet-4-6' },
        llamacpp: { model: 'glm-4.7-flash', baseURL: 'http://localhost:8080/v1' },
      },
    })
    const result = resolveEffectiveProvider(cfg, 'local')
    expect(result).toEqual({ provider: 'llamacpp', model: 'glm-4.7-flash' })
  })

  it('profile with only model uses top-level provider', () => {
    const cfg = makeConfig({
      profiles: { work: { model: 'gpt-4o' } },
    })
    const result = resolveEffectiveProvider(cfg, 'work')
    expect(result).toEqual({ provider: 'anthropic', model: 'gpt-4o' })
  })

  it('profile with only provider uses top-level model', () => {
    const cfg = makeConfig({
      profiles: { local: { provider: 'llamacpp' } },
    })
    const result = resolveEffectiveProvider(cfg, 'local')
    expect(result).toEqual({ provider: 'llamacpp', model: 'claude-sonnet-4-6' })
  })

  it('profile with neither provider nor model returns top-level values', () => {
    const cfg = makeConfig({
      profiles: { minimal: {} },
    })
    const result = resolveEffectiveProvider(cfg, 'minimal')
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })

  it('undefined activeProfileName returns top-level values', () => {
    const cfg = makeConfig()
    const result = resolveEffectiveProvider(cfg, undefined)
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })

  it('unknown profile name returns top-level values without crashing', () => {
    const cfg = makeConfig({
      profiles: { real: { provider: 'llamacpp' } },
    })
    const result = resolveEffectiveProvider(cfg, 'nonexistent')
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })
})
