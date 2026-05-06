import { describe, it, expect } from 'bun:test'
import { buildParentFromConfig } from './build-parent.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Provider } from '../providers/types.js'
import type { KristosConfig } from '../config/types.js'
import type { AgentJobConfig } from './config-schema.js'

const fakeProvider: Provider = {
  name: 'fake',
  async stream() {
    throw new Error('not used in these tests')
  },
}

const kcConfig: KristosConfig = {
  provider: 'anthropic',
  model: 'sonnet',
  temperature: 0.2,
  windowSize: 50,
  toolTimeoutMs: 30_000,
} as unknown as KristosConfig

const jobCfg: AgentJobConfig = {
  name: 'test',
  prompt: 'hi',
  schedule: 'hourly',
  permissionMode: 'agent',
  maxIterations: 20,
} as unknown as AgentJobConfig

describe('buildParentFromConfig — subagentParent wiring', () => {
  it('wires subagentParent in toolContext so the built-in task tool works', () => {
    const { parent } = buildParentFromConfig(jobCfg, kcConfig, {
      provider: fakeProvider,
      registry: new ToolRegistry(),
      sessionId: 'test-session',
    })

    expect(parent.toolContext.subagentParent).toBeDefined()
    expect(parent.toolContext.subagentParent?.provider).toBe(fakeProvider)
    expect(parent.toolContext.subagentParent?.toolContext.sessionId).toBe('test-session')
  })

  it('prevents recursive nesting (spawned subagent has no subagentParent)', () => {
    const { parent } = buildParentFromConfig(jobCfg, kcConfig, {
      provider: fakeProvider,
      registry: new ToolRegistry(),
      sessionId: 'test-session',
    })

    expect(parent.toolContext.subagentParent?.toolContext.subagentParent).toBeUndefined()
  })

  it('subagent inherits the same cwd / permission gate / audit attribution as parent', () => {
    const { parent } = buildParentFromConfig(jobCfg, kcConfig, {
      provider: fakeProvider,
      registry: new ToolRegistry(),
      sessionId: 'test-session',
      cwd: '/tmp/agent-test',
    })

    const outer = parent.toolContext
    const inner = parent.toolContext.subagentParent?.toolContext
    expect(inner?.cwd).toBe(outer.cwd)
    expect(inner?.mode).toBe(outer.mode)
    expect(inner?.sessionId).toBe(outer.sessionId)
    expect(inner?.originalCwd).toBe(outer.originalCwd)
  })
})
