import { describe, test, expect } from 'bun:test'
import { buildParentFromConfig } from '../../src/agent-runner/build-parent.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { DEFAULT_CONFIG, type KristosConfig } from '../../src/config/types.js'
import { createStubProvider } from '../fixtures/stub-provider.js'

function makeConfig(overrides: Partial<KristosConfig> = {}): KristosConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

function makeCtx() {
  return {
    provider: createStubProvider({ responses: [] }),
    registry: new ToolRegistry(),
    sessionId: 'agent-test-12345',
  }
}

describe('buildParentFromConfig (Phase 22-02)', () => {
  test('returns SubagentParent with agent mode and requested maxIterations', () => {
    const kc = makeConfig()
    const { parent, mcpServers, activeProfile } = buildParentFromConfig(
      { prompt: 'hi', maxIterations: 5 },
      kc,
      makeCtx(),
    )
    expect(parent.maxIterations).toBe(5)
    expect(parent.toolContext.mode).toBe('agent')
    expect(parent.toolContext.sessionId).toBe('agent-test-12345')
    expect(typeof parent.toolContext.checkPermission).toBe('function')
    expect(parent.temperature).toBe(kc.temperature)
    expect(parent.windowSize).toBe(kc.windowSize)
    expect(activeProfile).toBeUndefined()
    // No profiles configured → passthrough
    expect(mcpServers).toBe(kc.mcpServers)
  })

  test('defaults maxIterations to 20 when unset', () => {
    const { parent } = buildParentFromConfig({ prompt: 'hi' }, makeConfig(), makeCtx())
    expect(parent.maxIterations).toBe(20)
  })

  test('permissionMode override propagates to toolContext.mode', () => {
    const { parent } = buildParentFromConfig(
      { prompt: 'hi', permissionMode: 'yolo' },
      makeConfig(),
      makeCtx(),
    )
    expect(parent.toolContext.mode).toBe('yolo')
  })

  test('unknown profile throws a descriptive error', () => {
    const kc = makeConfig({
      profiles: {
        local: { mcpServers: [] },
      },
    })
    expect(() =>
      buildParentFromConfig({ prompt: 'hi', profile: 'nonexistent' }, kc, makeCtx()),
    ).toThrow(/nonexistent/)
  })

  test('known profile returns filtered mcpServers view', () => {
    const kc = makeConfig({
      mcpServers: {
        alpha: { command: 'x' },
        beta: { command: 'y' },
      },
      profiles: {
        onlyAlpha: { mcpServers: ['alpha'] },
      },
    })
    const { mcpServers, activeProfile } = buildParentFromConfig(
      { prompt: 'hi', profile: 'onlyAlpha' },
      kc,
      makeCtx(),
    )
    expect(activeProfile).toBe('onlyAlpha')
    expect(Object.keys(mcpServers ?? {})).toEqual(['alpha'])
  })

  test('checkPermission returns allow unconditionally', async () => {
    const { parent } = buildParentFromConfig({ prompt: 'hi' }, makeConfig(), makeCtx())
    const decision = await parent.toolContext.checkPermission!('bash', { cmd: 'ls' })
    expect(decision).toBe('allow')
  })
})
