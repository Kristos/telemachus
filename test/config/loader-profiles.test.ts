import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../../src/config/loader.js'

describe('loader profile pass-through (Phase 19)', () => {
  let tempHome: string
  let tempCwd: string
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'kc-home-'))
    tempCwd = await mkdtemp(join(tmpdir(), 'kc-cwd-'))
    originalHome = process.env.HOME
    process.env.HOME = tempHome
    await mkdir(join(tempHome, '.telemachus'), { recursive: true })
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempCwd, { recursive: true, force: true })
  })

  test('profiles, activeProfile, and schemaBudgetTok round-trip from global config', async () => {
    const globalCfg = {
      profiles: {
        local: { mcpServers: ['example_server'], cliTools: ['rg'] },
        cloud: { mcpServers: ['example_mcp'] },
      },
      activeProfile: 'local',
      mcpDefaults: { schemaBudgetTok: 250 },
      mcpServers: {
        example_server: { command: 'node', args: ['example.js'] },
        example_mcp: { command: 'node', args: ['example.js'] },
      },
    }
    await writeFile(
      join(tempHome, '.telemachus', 'config.json'),
      JSON.stringify(globalCfg),
    )

    const cfg = await loadConfig(tempCwd)

    expect(cfg.profiles).toBeDefined()
    expect(cfg.profiles?.local.mcpServers).toEqual(['example_server'])
    expect(cfg.profiles?.local.cliTools).toEqual(['rg'])
    expect(cfg.profiles?.cloud.mcpServers).toEqual(['example_mcp'])
    expect(cfg.activeProfile).toBe('local')
    expect(cfg.mcpDefaults?.schemaBudgetTok).toBe(250)
  })

  test('project-level activeProfile overrides global', async () => {
    await writeFile(
      join(tempHome, '.telemachus', 'config.json'),
      JSON.stringify({
        profiles: { local: {}, cloud: {} },
        activeProfile: 'local',
      }),
    )
    await mkdir(join(tempCwd, '.telemachus'), { recursive: true })
    await writeFile(
      join(tempCwd, '.telemachus', 'config.json'),
      JSON.stringify({ activeProfile: 'cloud' }),
    )

    const cfg = await loadConfig(tempCwd)
    expect(cfg.activeProfile).toBe('cloud')
    // Profiles from global still present
    expect(cfg.profiles?.local).toBeDefined()
  })

  test('config without profiles returns profiles: undefined', async () => {
    await writeFile(
      join(tempHome, '.telemachus', 'config.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6' }),
    )
    const cfg = await loadConfig(tempCwd)
    expect(cfg.profiles).toBeUndefined()
    expect(cfg.activeProfile).toBeUndefined()
  })
})
