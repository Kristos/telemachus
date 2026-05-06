import { describe, test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { registerCliTools } from './register.js'
import { getTier, clearCliTierOverrides } from '../security/trust-tiers.js'
import type { KristosConfig } from '../config/types.js'
import { DEFAULT_CONFIG } from '../config/types.js'

function makeConfig(cliTools?: KristosConfig['cliTools']): KristosConfig {
  return { ...DEFAULT_CONFIG, cliTools }
}

describe('registerCliTools', () => {
  afterEach(() => {
    clearCliTierOverrides()
  })

  test('undefined cliTools → empty array, no tier side-effects', () => {
    const tools = registerCliTools(makeConfig(undefined))
    expect(tools).toEqual([])
    expect(getTier('cli:anything')).toBe('dangerous')
  })

  test('empty cliTools → empty array', () => {
    const tools = registerCliTools(makeConfig({}))
    expect(tools).toEqual([])
  })

  test('two-entry config produces two Tools with matching names', () => {
    const tools = registerCliTools(
      makeConfig({
        gh: { command: 'gh', description: 'GitHub CLI', trustTier: 'risky' },
        docker: { command: 'docker', description: 'Docker CLI' },
      })
    )
    expect(tools).toHaveLength(2)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['docker', 'gh'])
  })

  test('registers cli:<name> tier overrides with default fail-closed', () => {
    registerCliTools(
      makeConfig({
        gh: { command: 'gh', description: 'GitHub CLI', trustTier: 'risky' },
        docker: { command: 'docker', description: 'Docker CLI' },
      })
    )
    expect(getTier('cli:gh')).toBe('risky')
    expect(getTier('cli:docker')).toBe('dangerous')
  })

  test('skips invalid entries (missing command or description) with stderr warning', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const tools = registerCliTools(
        makeConfig({
          ok: { command: 'gh', description: 'GitHub CLI' },
          // @ts-expect-error intentional bad shape
          nocmd: { description: 'missing command' },
          // @ts-expect-error intentional bad shape
          nodesc: { command: 'foo' },
        })
      )
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('ok')
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('buildAllTools', () => {
  test('composes allBuiltinTools with registerCliTools output', async () => {
    const { buildAllTools, allBuiltinTools } = await import('../tools/builtin/index.js')
    const all = buildAllTools(
      makeConfig({ gh: { command: 'gh', description: 'GitHub CLI' } })
    )
    expect(all.length).toBe(allBuiltinTools.length + 1)
    expect(all.some(t => t.name === 'gh')).toBe(true)
    clearCliTierOverrides()
  })

  test('buildAllTools with no cliTools returns just builtins', async () => {
    const { buildAllTools, allBuiltinTools } = await import('../tools/builtin/index.js')
    const all = buildAllTools(makeConfig(undefined))
    expect(all.length).toBe(allBuiltinTools.length)
  })
})
