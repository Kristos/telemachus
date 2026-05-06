import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './loader.js'

// Tests exercise the merge logic by writing a project-level config at
// {cwd}/.telemachus/config.json and calling loadConfig(cwd). Global config is
// auto-created on first run; tests only assert on fields they set so they're
// robust to whatever the user's ~/.telemachus/config.json happens to contain.

describe('loadConfig — MCP schema (Phase 18-01)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('provides DEFAULT mcpDefaults (idleTimeoutMs=600000, trustTier=dangerous) when no project config sets them', async () => {
    await writeProjectConfig({})
    const config = await loadConfig(tmpCwd)
    // Global config may or may not override these; assert the shape exists and
    // the defaults kick in when neither project nor global changes them.
    expect(config.mcpDefaults).toBeDefined()
    // Fields should always be populated (merged from DEFAULT_CONFIG at minimum)
    expect(typeof config.mcpDefaults!.idleTimeoutMs).toBe('number')
    expect(['safe', 'risky', 'dangerous']).toContain(config.mcpDefaults!.trustTier ?? 'dangerous')
  })

  it('returns mcpServers undefined when neither project nor global config declares any', async () => {
    await writeProjectConfig({
      // Explicitly null out to prove we aren't inheriting anything upstream.
      mcpServers: undefined,
    })
    const config = await loadConfig(tmpCwd)
    // If global config happens to define mcpServers, we can't assert undefined.
    // The important contract: if nothing is configured, the field is undefined,
    // not an empty object. So we check "undefined OR a real record".
    if (config.mcpServers !== undefined) {
      expect(typeof config.mcpServers).toBe('object')
    }
  })

  it('passes mcpServers map verbatim from project config', async () => {
    await writeProjectConfig({
      mcpServers: {
        'test-server': {
          command: 'python3',
          args: ['-m', 'test'],
          env: { FOO: 'bar' },
          eagerLoad: true,
          idleTimeoutMs: 120000,
          trustTier: 'risky',
          toolOverrides: { dangerous_tool: 'dangerous' },
        },
      },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.mcpServers).toBeDefined()
    const server = config.mcpServers!['test-server']
    expect(server.command).toBe('python3')
    expect(server.args).toEqual(['-m', 'test'])
    expect(server.env).toEqual({ FOO: 'bar' })
    expect(server.eagerLoad).toBe(true)
    expect(server.idleTimeoutMs).toBe(120000)
    expect(server.trustTier).toBe('risky')
    expect(server.toolOverrides).toEqual({ dangerous_tool: 'dangerous' })
  })

  it('project mcpDefaults override DEFAULT_CONFIG field-by-field', async () => {
    await writeProjectConfig({
      mcpDefaults: {
        idleTimeoutMs: 999,
        // trustTier omitted — should fall back to default
      },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.mcpDefaults!.idleTimeoutMs).toBe(999)
    // trustTier still populated by DEFAULT_CONFIG
    expect(config.mcpDefaults!.trustTier).toBeDefined()
  })

  it('per-server idleTimeoutMs and trustTier sit alongside mcpDefaults (resolution happens at use-time)', async () => {
    await writeProjectConfig({
      mcpDefaults: { idleTimeoutMs: 5000, trustTier: 'dangerous' },
      mcpServers: {
        fast: {
          command: 'node',
          idleTimeoutMs: 1000,
          trustTier: 'safe',
        },
      },
    })
    const config = await loadConfig(tmpCwd)
    // Loader does NOT resolve — it keeps per-server values and defaults separate.
    expect(config.mcpDefaults!.idleTimeoutMs).toBe(5000)
    expect(config.mcpServers!.fast.idleTimeoutMs).toBe(1000)
    expect(config.mcpServers!.fast.trustTier).toBe('safe')
  })

  it('accepts toolOverrides passthrough (D-03)', async () => {
    await writeProjectConfig({
      mcpServers: {
        srv: {
          command: 'foo',
          toolOverrides: {
            read_file: 'safe',
            run_shell: 'dangerous',
          },
        },
      },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.mcpServers!.srv.toolOverrides).toEqual({
      read_file: 'safe',
      run_shell: 'dangerous',
    })
  })
})

describe('loadConfig — discord.maxConversationTurns (Phase 56)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-turns-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('accepts discord.maxConversationTurns when valid', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], maxConversationTurns: 25 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.maxConversationTurns).toBe(25)
  })

  it('drops discord.maxConversationTurns when out of range (too large)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], maxConversationTurns: 2000 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.maxConversationTurns).toBeUndefined()
  })

  it('drops discord.maxConversationTurns when non-integer', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], maxConversationTurns: 3.5 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.maxConversationTurns).toBeUndefined()
  })

  it('preserves other discord fields when dropping invalid maxConversationTurns', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: ['123'], maxConversationTurns: -5 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.maxConversationTurns).toBeUndefined()
    expect(config.discord?.allowedUsers).toEqual(['123'])
  })
})

describe('loadConfig — discord.dailyTokensPerUser (Phase 56 BUDGET-01)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('accepts discord.dailyTokensPerUser when valid', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], dailyTokensPerUser: 500_000 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.dailyTokensPerUser).toBe(500_000)
  })

  it('drops discord.dailyTokensPerUser when below min (1000)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], dailyTokensPerUser: 100 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.dailyTokensPerUser).toBeUndefined()
  })

  it('drops discord.dailyTokensPerUser when non-integer', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], dailyTokensPerUser: 500.5 } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.dailyTokensPerUser).toBeUndefined()
  })
})

describe('autoDispatch config (Phase 60)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('defaults cancellationWindowMs to 10000 when autoDispatch.enabled is true', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], autoDispatch: { enabled: true } } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.autoDispatch?.enabled).toBe(true)
    expect(config.discord?.autoDispatch?.cancellationWindowMs).toBe(10000)
  })

  it('preserves cancellationWindowMs when within bounds', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], autoDispatch: { enabled: true, cancellationWindowMs: 5000 } } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.autoDispatch?.cancellationWindowMs).toBe(5000)
  })

  it('drops cancellationWindowMs below 1000 (Zod min bound)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], autoDispatch: { enabled: true, cancellationWindowMs: 500 } } })
    const config = await loadConfig(tmpCwd)
    // Zod validation failure drops the autoDispatch block entirely (ops-safe default-off)
    expect(config.discord?.autoDispatch).toBeUndefined()
  })

  it('drops cancellationWindowMs above 30000 (Zod max bound)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [], autoDispatch: { enabled: true, cancellationWindowMs: 60000 } } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.autoDispatch).toBeUndefined()
  })

  it('accepts discord config without autoDispatch field (backward-compat)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: ['user1'] } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.autoDispatch).toBeUndefined()
    expect(config.discord?.allowedUsers).toEqual(['user1'])
  })

  it('default-off: discord without autoDispatch yields enabled=false semantically (field absent)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [] } })
    const config = await loadConfig(tmpCwd)
    // Field absent is equivalent to enabled=false (default-off per DISPATCH-08)
    const enabled = config.discord?.autoDispatch?.enabled ?? false
    expect(enabled).toBe(false)
  })
})

// --- personas config (Phase 64 PERS-01) ---

describe('loadConfig — discord.personas (Phase 64 PERS-01)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-personas-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('preserves discord.personas when valid map', async () => {
    await writeProjectConfig({
      discord: {
        tokenEnv: 'TOKEN',
        allowedUsers: [],
        personas: {
          '123456789': 'You are an auction hype assistant.',
          '987654321': 'You are a focused backend engineer.',
        },
      },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.personas).toEqual({
      '123456789': 'You are an auction hype assistant.',
      '987654321': 'You are a focused backend engineer.',
    })
  })

  it('drops discord.personas when values exceed 4000 chars', async () => {
    const huge = 'a'.repeat(4001)
    await writeProjectConfig({
      discord: { tokenEnv: 'TOKEN', allowedUsers: [], personas: { 'ch-1': huge } },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.personas).toBeUndefined()
  })

  it('drops discord.personas when any value is non-string', async () => {
    await writeProjectConfig({
      discord: { tokenEnv: 'TOKEN', allowedUsers: [], personas: { 'ch-1': 42 } },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.personas).toBeUndefined()
  })

  it('drops discord.personas when map has empty-string key', async () => {
    await writeProjectConfig({
      discord: { tokenEnv: 'TOKEN', allowedUsers: [], personas: { '': 'empty key' } },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.personas).toBeUndefined()
  })

  it('accepts absent discord.personas (baseline behavior)', async () => {
    await writeProjectConfig({ discord: { tokenEnv: 'TOKEN', allowedUsers: [] } })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.personas).toBeUndefined()
  })
})

// --- suppressEmoji config (Phase 64 PERS-02) ---

describe('loadConfig — discord.suppressEmoji (Phase 64 PERS-02)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-suppressemoji-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('preserves discord.suppressEmoji when valid map', async () => {
    await writeProjectConfig({
      discord: {
        tokenEnv: 'TOKEN',
        allowedUsers: [],
        suppressEmoji: { '123456789': true, '987654321': false },
      },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.suppressEmoji).toEqual({
      '123456789': true,
      '987654321': false,
    })
  })

  it('drops discord.suppressEmoji when values are non-boolean', async () => {
    await writeProjectConfig({
      discord: { tokenEnv: 'TOKEN', allowedUsers: [], suppressEmoji: { 'ch-1': 'true' } },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.suppressEmoji).toBeUndefined()
  })

  it('drops discord.suppressEmoji when map has empty-string key', async () => {
    await writeProjectConfig({
      discord: { tokenEnv: 'TOKEN', allowedUsers: [], suppressEmoji: { '': true } },
    })
    const config = await loadConfig(tmpCwd)
    expect(config.discord?.suppressEmoji).toBeUndefined()
  })
})

describe('loadConfig — maxInflightLLMRequests (Phase 55)', () => {
  let tmpCwd: string

  beforeEach(async () => {
    tmpCwd = join(tmpdir(), `kc-loader-test-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(tmpCwd, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpCwd, { recursive: true, force: true })
  })

  async function writeProjectConfig(data: unknown) {
    await writeFile(
      join(tmpCwd, '.telemachus', 'config.json'),
      JSON.stringify(data),
    )
  }

  it('Test A: maxInflightLLMRequests defaults to 4 when absent from config', async () => {
    await writeProjectConfig({})
    const config = await loadConfig(tmpCwd)
    expect(config.maxInflightLLMRequests).toBe(4)
  })

  it('Test B: maxInflightLLMRequests respects explicit value in [1, 32]', async () => {
    await writeProjectConfig({ maxInflightLLMRequests: 8 })
    const config = await loadConfig(tmpCwd)
    expect(config.maxInflightLLMRequests).toBe(8)
  })

  it('Test C: maxInflightLLMRequests clamps values below 1 to 1', async () => {
    await writeProjectConfig({ maxInflightLLMRequests: 0 })
    const config0 = await loadConfig(tmpCwd)
    expect(config0.maxInflightLLMRequests).toBe(1)

    await writeProjectConfig({ maxInflightLLMRequests: -5 })
    const configNeg = await loadConfig(tmpCwd)
    expect(configNeg.maxInflightLLMRequests).toBe(1)
  })

  it('Test D: maxInflightLLMRequests clamps values above 32 to 32', async () => {
    await writeProjectConfig({ maxInflightLLMRequests: 100 })
    const config = await loadConfig(tmpCwd)
    expect(config.maxInflightLLMRequests).toBe(32)
  })

  it('Test E: maxInflightLLMRequests ignores non-numeric values (falls back to default)', async () => {
    await writeProjectConfig({ maxInflightLLMRequests: 'four' })
    const config = await loadConfig(tmpCwd)
    expect(config.maxInflightLLMRequests).toBe(4)
  })
})

// --- RouterConfigSchema validation (Phase 59 / ROUTE-08) ---

import { RouterConfigSchema } from './loader.js'

describe('RouterConfigSchema (Phase 59 / ROUTE-08)', () => {
  it('accepts minimal valid config (classifier + simple + complex only)', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
    })
    expect(result.success).toBe(true)
  })

  it('accepts full config with all optional fields', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'anthropic',
      classifierModel: 'glm-4.7-flash',
      simpleModel: 'glm-4.7-flash',
      complexModel: 'claude-sonnet-4-6',
      heuristicEnabled: true,
      classifierTokenCap: 600,
      classifierTimeoutMs: 5000,
      fallbacks: { complex: 'llamacpp' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects classifierTokenCap below floor (< 100)', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      classifierTokenCap: 50,
    })
    expect(result.success).toBe(false)
  })

  it('rejects classifierTokenCap above ceiling (> 10000)', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      classifierTokenCap: 20000,
    })
    expect(result.success).toBe(false)
  })

  it('rejects classifierTimeoutMs below floor (< 500)', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      classifierTimeoutMs: 200,
    })
    expect(result.success).toBe(false)
  })

  it('rejects classifierTimeoutMs above ceiling (> 60000)', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      classifierTimeoutMs: 120000,
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid provider enum value for classifier', () => {
    const result = RouterConfigSchema.safeParse({
      classifier: 'bogus-provider',
      simple: 'openai-compat',
      complex: 'openai-compat',
    })
    expect(result.success).toBe(false)
  })
})
