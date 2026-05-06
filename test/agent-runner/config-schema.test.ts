import { describe, test, expect } from 'bun:test'
import type { AgentJobConfig } from '../../src/agent-runner/config-schema.js'
import type { KristosConfig } from '../../src/config/types.js'
import type { PermissionMode } from '../../src/permissions/types.js'

describe('AgentJobConfig type (Phase 22-01)', () => {
  test('satisfies required/optional shape', () => {
    const minimal: AgentJobConfig = { prompt: 'hi' }
    expect(minimal.prompt).toBe('hi')

    const full: AgentJobConfig = {
      prompt: 'do a thing',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      profile: 'local',
      permissionMode: 'agent',
      maxIterations: 10,
      maxWallClockMs: 60_000,
      maxTotalTokens: 100_000,
      schedule: '0 9 * * *',
      output: { path: '/tmp/out.log' },
    }
    expect(full.permissionMode).toBe('agent')
    expect(full.maxIterations).toBe(10)

    // permissionMode narrowed to 'yolo' | 'agent'
    const yolo: AgentJobConfig = { prompt: 'x', permissionMode: 'yolo' }
    expect(yolo.permissionMode).toBe('yolo')
  })

  test("PermissionMode union includes 'agent'", () => {
    const m: PermissionMode = 'agent'
    expect(m).toBe('agent')
    // also still includes prior values
    const modes: PermissionMode[] = ['yolo', 'ask', 'readonly', 'plan', 'agent']
    expect(modes).toHaveLength(5)
  })

  test('KristosConfig.agents round-trips from JSON blob', () => {
    const raw = `{
      "agents": {
        "daily": { "prompt": "hi", "maxIterations": 5 },
        "weekly": { "prompt": "bye", "permissionMode": "agent", "maxWallClockMs": 30000 }
      }
    }`
    const parsed = JSON.parse(raw) as Partial<KristosConfig>
    expect(parsed.agents).toBeDefined()
    expect(parsed.agents?.daily?.prompt).toBe('hi')
    expect(parsed.agents?.daily?.maxIterations).toBe(5)
    expect(parsed.agents?.weekly?.permissionMode).toBe('agent')
    expect(parsed.agents?.weekly?.maxWallClockMs).toBe(30000)
  })

  test('KristosConfig.agents is optional (absent = v1.4 compat)', () => {
    const cfg: Partial<KristosConfig> = {}
    expect(cfg.agents).toBeUndefined()
  })
})
