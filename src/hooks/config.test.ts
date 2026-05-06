import { describe, test, expect } from 'bun:test'
import { loadHooks, matchHooks } from './config'
import type { HookConfig } from './types'
import type { ClaudeJsonConfig } from '../config/mcp-config'

const fakeReader = (data: any) => async (): Promise<ClaudeJsonConfig> => data

describe('loadHooks', () => {
  test('returns empty config when reader returns empty object', async () => {
    const result = await loadHooks(fakeReader({}))
    expect(result).toEqual({})
  })

  test('returns empty config when hooks key absent', async () => {
    const result = await loadHooks(fakeReader({ mcpServers: {} }))
    expect(result).toEqual({})
  })

  test('returns parsed HookConfig preserving all three events', async () => {
    const hooks: HookConfig = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'b' }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'c' }] }],
    }
    const result = await loadHooks(fakeReader({ hooks }))
    expect(result).toEqual(hooks)
  })

  test('returns empty config when reader throws', async () => {
    const result = await loadHooks(async () => {
      throw new Error('boom')
    })
    expect(result).toEqual({})
  })
})

describe('matchHooks', () => {
  const config: HookConfig = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'pre-bash' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pre-ew' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'pre-all' }] },
      { matcher: '[invalid(', hooks: [{ type: 'command', command: 'pre-bad' }] },
    ],
    Stop: [
      { matcher: 'ignored', hooks: [{ type: 'command', command: 'stop-1' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'stop-2' }] },
    ],
  }

  test('matches Bash for matcher Bash', () => {
    const r = matchHooks('PreToolUse', 'Bash', config).map((c) => c.command)
    expect(r).toContain('pre-bash')
    expect(r).toContain('pre-all')
    expect(r).not.toContain('pre-ew')
  })

  test('Edit|Write matches Edit and Write but not Read', () => {
    expect(matchHooks('PreToolUse', 'Edit', config).map((c) => c.command)).toContain('pre-ew')
    expect(matchHooks('PreToolUse', 'Write', config).map((c) => c.command)).toContain('pre-ew')
    expect(matchHooks('PreToolUse', 'Read', config).map((c) => c.command)).not.toContain('pre-ew')
  })

  test('empty matcher matches every tool', () => {
    expect(matchHooks('PreToolUse', 'AnyTool', config).map((c) => c.command)).toContain('pre-all')
  })

  test('Stop event returns all hooks regardless of matcher', () => {
    const r = matchHooks('Stop', '', config).map((c) => c.command)
    expect(r).toEqual(['stop-1', 'stop-2'])
  })

  test('invalid regex is skipped, other matchers still returned', () => {
    const r = matchHooks('PreToolUse', 'Bash', config).map((c) => c.command)
    expect(r).not.toContain('pre-bad')
    expect(r).toContain('pre-bash')
  })
})
