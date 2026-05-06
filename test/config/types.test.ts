import { describe, test, expect } from 'bun:test'
import { DEFAULT_CONFIG, type KristosConfig, type ProfileConfig } from '../../src/config/types.js'

describe('KristosConfig profile types (Phase 19)', () => {
  test('DEFAULT_CONFIG is assignable to KristosConfig (v1.3 compat)', () => {
    const cfg: KristosConfig = { ...DEFAULT_CONFIG }
    expect(cfg.profiles).toBeUndefined()
    expect(cfg.activeProfile).toBeUndefined()
  })

  test('v1.3-shape config without profiles satisfies KristosConfig', () => {
    const cfg: KristosConfig = {
      ...DEFAULT_CONFIG,
      mcpServers: {
        example_server: { command: 'node', args: ['server.js'] },
      },
    }
    expect(cfg.mcpServers?.example_server.command).toBe('node')
  })

  test('config with profiles + activeProfile is assignable', () => {
    const profile: ProfileConfig = {
      mcpServers: ['example_server'],
      cliTools: ['rg'],
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      permissionMode: 'yolo',
    }
    const cfg: KristosConfig = {
      ...DEFAULT_CONFIG,
      profiles: { local: profile },
      activeProfile: 'local',
    }
    expect(cfg.profiles?.local.mcpServers).toEqual(['example_server'])
    expect(cfg.activeProfile).toBe('local')
  })

  test('mcpDefaults.schemaBudgetTok is accepted', () => {
    const cfg: KristosConfig = {
      ...DEFAULT_CONFIG,
      mcpDefaults: {
        ...DEFAULT_CONFIG.mcpDefaults,
        schemaBudgetTok: 200,
      },
    }
    expect(cfg.mcpDefaults?.schemaBudgetTok).toBe(200)
  })
})
