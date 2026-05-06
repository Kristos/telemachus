import { describe, test, expect, afterEach } from 'bun:test'
import {
  getTier,
  TOOL_TIERS,
  setMcpTierOverrides,
  clearMcpTierOverrides,
  setCliTierOverrides,
  clearCliTierOverrides,
} from './trust-tiers.js'

describe('trust tiers', () => {
  test.each([
    ['file_read', 'safe'] as const,
    ['grep', 'safe'] as const,
    ['glob', 'safe'] as const,
    ['todo_write', 'safe'] as const,
    ['ask_user_question', 'safe'] as const,
  ])('getTier(%s) === %s', (tool, expected) => {
    expect(getTier(tool)).toBe(expected)
  })

  test.each([
    ['file_write', 'risky'] as const,
    ['file_edit', 'risky'] as const,
    ['web_search', 'risky'] as const,
    ['web_fetch', 'risky'] as const,
  ])('getTier(%s) === %s', (tool, expected) => {
    expect(getTier(tool)).toBe(expected)
  })

  test.each([
    ['bash', 'dangerous'] as const,
    ['task', 'dangerous'] as const,
    ['worktree', 'dangerous'] as const,
  ])('getTier(%s) === %s', (tool, expected) => {
    expect(getTier(tool)).toBe(expected)
  })

  test('unknown tools default to dangerous (fail-closed)', () => {
    expect(getTier('nonexistent_tool_xyz')).toBe('dangerous')
    expect(getTier('')).toBe('dangerous')
  })

  test('TOOL_TIERS is a plain object', () => {
    expect(typeof TOOL_TIERS).toBe('object')
    expect(TOOL_TIERS).not.toBeNull()
  })
})

describe('mcp tier overrides (MCP-06)', () => {
  afterEach(() => {
    clearMcpTierOverrides()
  })

  test('mcp default: unknown mcp__ tool is dangerous with empty overrides', () => {
    expect(getTier('mcp__foo__bar')).toBe('dangerous')
  })

  test('override promotes: setMcpTierOverrides lets a tool become safe', () => {
    setMcpTierOverrides({ 'mcp__foo__bar': 'safe' })
    expect(getTier('mcp__foo__bar')).toBe('safe')
  })

  test('override scoped: sibling tool on same server is not affected', () => {
    setMcpTierOverrides({ 'mcp__foo__bar': 'safe' })
    expect(getTier('mcp__foo__bar')).toBe('safe')
    expect(getTier('mcp__foo__baz')).toBe('dangerous')
  })

  test('builtin unaffected: an mcp override does not bleed into TOOL_TIERS', () => {
    setMcpTierOverrides({ 'mcp__foo__bar': 'safe' })
    expect(getTier('bash')).toBe('dangerous')
    expect(getTier('file_read')).toBe('safe')
    expect(getTier('file_write')).toBe('risky')
  })

  test('clear: clearMcpTierOverrides resets the map', () => {
    setMcpTierOverrides({ 'mcp__foo__bar': 'safe' })
    expect(getTier('mcp__foo__bar')).toBe('safe')
    clearMcpTierOverrides()
    expect(getTier('mcp__foo__bar')).toBe('dangerous')
  })
})

describe('cli tier overrides (LEAN-02)', () => {
  afterEach(() => {
    clearCliTierOverrides()
    clearMcpTierOverrides()
  })

  test('unknown cli: tool is dangerous with empty overrides (fail-closed)', () => {
    expect(getTier('cli:unknown')).toBe('dangerous')
  })

  test('setCliTierOverrides promotes cli:gh to the configured tier', () => {
    setCliTierOverrides({ 'cli:gh': 'risky' })
    expect(getTier('cli:gh')).toBe('risky')
  })

  test('cli override scoped: sibling cli tool not affected', () => {
    setCliTierOverrides({ 'cli:gh': 'risky' })
    expect(getTier('cli:gh')).toBe('risky')
    expect(getTier('cli:docker')).toBe('dangerous')
  })

  test('clearCliTierOverrides resets the map', () => {
    setCliTierOverrides({ 'cli:gh': 'safe' })
    expect(getTier('cli:gh')).toBe('safe')
    clearCliTierOverrides()
    expect(getTier('cli:gh')).toBe('dangerous')
  })

  test('mcp overrides take precedence over cli overrides on key collision', () => {
    setMcpTierOverrides({ 'collide': 'safe' })
    setCliTierOverrides({ 'collide': 'dangerous' })
    expect(getTier('collide')).toBe('safe')
  })

  test('cli overrides do not bleed into builtin TOOL_TIERS', () => {
    setCliTierOverrides({ 'cli:gh': 'safe' })
    expect(getTier('bash')).toBe('dangerous')
    expect(getTier('file_read')).toBe('safe')
  })
})
