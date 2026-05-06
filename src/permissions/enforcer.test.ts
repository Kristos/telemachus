import { describe, test, expect } from 'bun:test'
import { resolveMode, checkPermission, extractCommandSummary } from './enforcer.js'

describe('resolveMode', () => {
  test('returns config default when no env or CLI provided', () => {
    expect(resolveMode('yolo', undefined, undefined)).toBe('yolo')
  })

  test('returns env mode when provided and CLI is absent', () => {
    expect(resolveMode('yolo', 'ask', undefined)).toBe('ask')
  })

  test('returns CLI mode when provided (CLI wins over config)', () => {
    expect(resolveMode('yolo', undefined, 'readonly')).toBe('readonly')
  })

  test('returns CLI mode when both env and CLI provided (CLI wins over env)', () => {
    expect(resolveMode('yolo', 'ask', 'readonly')).toBe('readonly')
  })

  test('ignores invalid env value and falls back to config', () => {
    expect(resolveMode('yolo', 'invalid', undefined)).toBe('yolo')
  })

  test('ignores invalid CLI value and falls back to config', () => {
    expect(resolveMode('yolo', undefined, 'invalid')).toBe('yolo')
  })

  test('ignores invalid env but uses valid CLI', () => {
    expect(resolveMode('yolo', 'invalid', 'ask')).toBe('ask')
  })

  test('accepts plan from CLI', () => {
    expect(resolveMode('yolo', undefined, 'plan')).toBe('plan')
  })

  test('accepts plan from env', () => {
    expect(resolveMode('yolo', 'plan', undefined)).toBe('plan')
  })
})

describe('checkPermission - plan mode', () => {
  test('denies bash in plan mode with reason containing plan mode', () => {
    const result = checkPermission('plan', 'bash', { command: 'rm -rf /' })
    expect(result.action).toBe('deny')
    if (result.action === 'deny') {
      expect(result.reason).toContain('plan mode')
    }
  })

  test('denies file_write in plan mode', () => {
    const result = checkPermission('plan', 'file_write', { file_path: 'foo' })
    expect(result.action).toBe('deny')
  })

  test('denies file_edit in plan mode', () => {
    const result = checkPermission('plan', 'file_edit', { file_path: 'foo' })
    expect(result.action).toBe('deny')
  })

  test('allows file_read in plan mode', () => {
    expect(checkPermission('plan', 'file_read', { file_path: 'foo' })).toEqual({ action: 'allow' })
  })

  test('allows grep in plan mode', () => {
    expect(checkPermission('plan', 'grep', {})).toEqual({ action: 'allow' })
  })

  test('allows todo_write in plan mode (safe tools win)', () => {
    expect(checkPermission('plan', 'todo_write', {})).toEqual({ action: 'allow' })
  })

  test('denies web_search in plan mode (risky tier)', () => {
    const result = checkPermission('plan', 'web_search', {})
    expect(result.action).toBe('deny')
  })

  test('denies web_fetch in plan mode (risky tier)', () => {
    const result = checkPermission('plan', 'web_fetch', {})
    expect(result.action).toBe('deny')
  })
})

describe('checkPermission - yolo mode', () => {
  test('allows bash in yolo mode', () => {
    expect(checkPermission('yolo', 'bash', {})).toEqual({ action: 'allow' })
  })

  test('allows file_write in yolo mode', () => {
    expect(checkPermission('yolo', 'file_write', {})).toEqual({ action: 'allow' })
  })

  test('allows file_edit in yolo mode', () => {
    expect(checkPermission('yolo', 'file_edit', {})).toEqual({ action: 'allow' })
  })

  test('allows web_search in yolo mode', () => {
    expect(checkPermission('yolo', 'web_search', {})).toEqual({ action: 'allow' })
  })
})

describe('checkPermission - readonly mode', () => {
  test('denies bash in readonly mode with reason containing readonly', () => {
    const result = checkPermission('readonly', 'bash', {})
    expect(result.action).toBe('deny')
    if (result.action === 'deny') {
      expect(result.reason).toContain('readonly')
    }
  })

  test('denies file_write in readonly mode', () => {
    const result = checkPermission('readonly', 'file_write', {})
    expect(result.action).toBe('deny')
    if (result.action === 'deny') {
      expect(result.reason).toContain('readonly')
    }
  })

  test('denies file_edit in readonly mode', () => {
    const result = checkPermission('readonly', 'file_edit', {})
    expect(result.action).toBe('deny')
    if (result.action === 'deny') {
      expect(result.reason).toContain('readonly')
    }
  })

  test('allows file_read in readonly mode', () => {
    expect(checkPermission('readonly', 'file_read', {})).toEqual({ action: 'allow' })
  })

  test('allows grep in readonly mode', () => {
    expect(checkPermission('readonly', 'grep', {})).toEqual({ action: 'allow' })
  })

  test('allows glob in readonly mode', () => {
    expect(checkPermission('readonly', 'glob', {})).toEqual({ action: 'allow' })
  })

  test('denies web_search in readonly mode (risky tier)', () => {
    const result = checkPermission('readonly', 'web_search', {})
    expect(result.action).toBe('deny')
  })
})

describe('checkPermission - ask mode', () => {
  test('returns ask for bash with command summary', () => {
    const result = checkPermission('ask', 'bash', { command: 'ls -la' })
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.toolName).toBe('bash')
      expect(result.command).toBe('ls -la')
    }
  })

  test('returns ask for file_write with file_path summary', () => {
    const result = checkPermission('ask', 'file_write', { file_path: '/tmp/x' })
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.toolName).toBe('file_write')
      expect(result.command).toBe('/tmp/x')
    }
  })

  test('allows file_read in ask mode (safe tool)', () => {
    expect(checkPermission('ask', 'file_read', {})).toEqual({ action: 'allow' })
  })

  test('returns ask for MCP tool (non-safe, unknown → dangerous) in ask mode', () => {
    const result = checkPermission('ask', 'mcp__server__tool', {})
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.toolName).toBe('mcp__server__tool')
    }
  })

  // SEC-01: web_search is now risky — prompts in ask mode (was allow before this plan)
  test('returns ask for web_search in ask mode (reclassified from safe to risky)', () => {
    const result = checkPermission('ask', 'web_search', {})
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.toolName).toBe('web_search')
    }
  })

  test('returns ask for web_fetch in ask mode (risky tier)', () => {
    const result = checkPermission('ask', 'web_fetch', {})
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.toolName).toBe('web_fetch')
    }
  })

  test('allows glob in ask mode (safe tool)', () => {
    expect(checkPermission('ask', 'glob', {})).toEqual({ action: 'allow' })
  })

  test('allows ask_user_question in ask mode (safe tool)', () => {
    expect(checkPermission('ask', 'ask_user_question', {})).toEqual({ action: 'allow' })
  })
})

describe('checkPermission - safe tier always allows', () => {
  const safeModes = ['yolo', 'ask', 'readonly', 'plan'] as const

  for (const mode of safeModes) {
    test(`file_read allowed in ${mode} mode`, () => {
      expect(checkPermission(mode, 'file_read', {})).toEqual({ action: 'allow' })
    })
  }
})

describe('extractCommandSummary', () => {
  test('extracts command field for bash', () => {
    expect(extractCommandSummary('bash', { command: 'echo hello' })).toBe('echo hello')
  })

  test('extracts file_path for file_write', () => {
    expect(extractCommandSummary('file_write', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts')
  })

  test('extracts file_path for file_edit', () => {
    expect(extractCommandSummary('file_edit', { file_path: '/tmp/edit.ts' })).toBe('/tmp/edit.ts')
  })

  test('falls back to JSON stringify for unknown tool', () => {
    const result = extractCommandSummary('unknown_tool', { some: 'value' })
    expect(result).toContain('some')
  })

  test('truncates long bash command to 80 chars', () => {
    const longCmd = 'a'.repeat(100)
    const result = extractCommandSummary('bash', { command: longCmd })
    expect(result.length).toBeLessThanOrEqual(80)
  })

  // SEC-04 prep: network prefix
  test('prepends [network] for bash with network: true', () => {
    const result = extractCommandSummary('bash', { command: 'curl https://example.com', network: true })
    expect(result).toBe('[network] curl https://example.com')
  })

  test('no [network] prefix when network absent', () => {
    const result = extractCommandSummary('bash', { command: 'ls' })
    expect(result).toBe('ls')
  })

  test('no [network] prefix when network: false', () => {
    const result = extractCommandSummary('bash', { command: 'ls', network: false })
    expect(result).toBe('ls')
  })
})
