import { describe, test, expect } from 'bun:test'
import { allBuiltinTools, buildAllTools } from './index.js'
import type { KristosConfig } from '../../config/types.js'
import type { IndexClient } from '../../project-index/client.js'

const baseConfig: KristosConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  windowSize: 40,
  permissionMode: 'ask',
  temperature: 0.7,
  maxIterations: 50,
  toolTimeoutMs: 30000,
  autoCompactThreshold: 90,
    contextTokenBudget: 8000,
  maxInflightLLMRequests: 4,
  providerConfigs: {
    anthropic: { model: 'claude-sonnet-4-6' },
  },
}

// Minimal mock IndexClient
const mockIndexClient: IndexClient = {
  getFilesByGlob: () => [],
  getFilesByLanguage: () => [],
  getFilesByExtension: () => [],
  getFile: () => null,
}

describe('buildAllTools — v1.4 milestone-audit regression guard', () => {
  test('returns all builtin tools when no cliTools in config', () => {
    const tools = buildAllTools(baseConfig)
    expect(tools.length).toBe(allBuiltinTools.length)
    for (const builtin of allBuiltinTools) {
      expect(tools.some((t) => t.name === builtin.name)).toBe(true)
    }
  })

  test('composes builtin tools + configured CLI tools into a single registry', () => {
    const config: KristosConfig = {
      ...baseConfig,
      cliTools: {
        gh: {
          command: 'gh',
          description: 'GitHub CLI',
          trustTier: 'risky',
        },
        docker: {
          command: 'docker',
          description: 'Docker CLI',
          trustTier: 'dangerous',
        },
      },
    }
    const tools = buildAllTools(config)

    // All builtins still present
    expect(tools.length).toBe(allBuiltinTools.length + 2)

    // Both CLI tools registered
    const names = tools.map((t) => t.name)
    expect(names).toContain('gh')
    expect(names).toContain('docker')
  })

  test('milestone-audit regression: index.ts must call buildAllTools not allBuiltinTools', async () => {
    // Smoke guard — ensures src/index.ts wires through buildAllTools so CLI
    // tools actually reach the model. This caught a real LEAN-02 wiring gap
    // during v1.4 milestone audit (internal v1.4 audit).
    // Phase 51 added a second arg (IndexClient); Phase 55 preserved the call.
    // Match the function name + first arg prefix rather than the exact call string.
    const indexSrc = await Bun.file('src/index.ts').text()
    expect(indexSrc).toContain('buildAllTools(config,')
    expect(indexSrc).not.toMatch(/registry\.registerAll\(allBuiltinTools\)/)
  })
})

describe('buildAllTools — IndexClient opt-in (Phase 48)', () => {
  test('Test 1: no indexClient returns original glob and grep objects', () => {
    const tools = buildAllTools(baseConfig)
    const glob = tools.find((t) => t.name === 'glob')
    const grep = tools.find((t) => t.name === 'grep')
    const originalGlob = allBuiltinTools.find((t) => t.name === 'glob')
    const originalGrep = allBuiltinTools.find((t) => t.name === 'grep')
    // Without indexClient, should be same reference
    expect(glob).toBe(originalGlob)
    expect(grep).toBe(originalGrep)
  })

  test('Test 2: provided indexClient returns wrapped glob and grep (different references)', () => {
    const tools = buildAllTools(baseConfig, mockIndexClient)
    const glob = tools.find((t) => t.name === 'glob')
    const grep = tools.find((t) => t.name === 'grep')
    const originalGlob = allBuiltinTools.find((t) => t.name === 'glob')
    const originalGrep = allBuiltinTools.find((t) => t.name === 'grep')
    // With indexClient, should be different (wrapped) references
    expect(glob).not.toBe(originalGlob)
    expect(grep).not.toBe(originalGrep)
    // But names should be preserved
    expect(glob?.name).toBe('glob')
    expect(grep?.name).toBe('grep')
  })

  test('Test 3: null indexClient same as no indexClient — original tools returned', () => {
    const toolsNull = buildAllTools(baseConfig, null)
    const toolsUndefined = buildAllTools(baseConfig)
    const globNull = toolsNull.find((t) => t.name === 'glob')
    const globUndef = toolsUndefined.find((t) => t.name === 'glob')
    const originalGlob = allBuiltinTools.find((t) => t.name === 'glob')
    expect(globNull).toBe(originalGlob)
    expect(globUndef).toBe(originalGlob)
  })

  test('Test 4: non-glob/grep builtins are unchanged regardless of indexClient', () => {
    const withIndex = buildAllTools(baseConfig, mockIndexClient)
    const without = buildAllTools(baseConfig)
    // bash, fileRead, fileWrite, etc. should be the same references in both
    for (const builtin of allBuiltinTools) {
      if (builtin.name === 'glob' || builtin.name === 'grep') continue
      const withTool = withIndex.find((t) => t.name === builtin.name)
      const withoutTool = without.find((t) => t.name === builtin.name)
      expect(withTool).toBe(builtin)
      expect(withoutTool).toBe(builtin)
    }
  })
})
