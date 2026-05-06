import { test, expect, describe } from 'bun:test'
import { exportSessionToMarkdown } from './export-md.js'
import type { Message } from '../../providers/types.js'

const meta = {
  sessionId: 'sess-123',
  model: 'claude-sonnet',
  providerKey: 'anthropic',
  startedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
}

describe('exportSessionToMarkdown', () => {
  test('empty array → frontmatter only', () => {
    const out = exportSessionToMarkdown([], { ...meta, startedAt: undefined })
    expect(out).toContain('# Session sess-123')
    expect(out).toContain('- model: anthropic/claude-sonnet')
    expect(out).toContain('- started: unknown')
    expect(out).toContain('- messages: 0')
    expect(out.trimEnd().endsWith('---')).toBe(true)
  })

  test('user + assistant text exchange', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ]
    const out = exportSessionToMarkdown(messages, meta)
    const userIdx = out.indexOf('## User')
    const asstIdx = out.indexOf('## Assistant')
    expect(userIdx).toBeGreaterThan(-1)
    expect(asstIdx).toBeGreaterThan(userIdx)
    expect(out).toContain('Hello there')
    expect(out).toContain('Hi! How can I help?')
  })

  test('assistant message with text + tool calls', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'Let me check that file',
        toolCalls: [
          { id: 't1', name: 'Read', input: { path: '/etc/hosts' } },
        ],
      },
    ]
    const out = exportSessionToMarkdown(messages, meta)
    expect(out).toContain('## Assistant')
    expect(out).toContain('Let me check that file')
    expect(out).toContain('**Tool call:** `Read`')
    expect(out).toContain('"path":"/etc/hosts"')
  })

  test('tool result message → fenced code block', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'file contents here', toolCallId: 't1' },
    ]
    const out = exportSessionToMarkdown(messages, meta)
    expect(out).toContain('### Tool result')
    expect(out).toContain('```\nfile contents here\n```')
  })

  test('system message is omitted', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'hi' },
    ]
    const out = exportSessionToMarkdown(messages, meta)
    expect(out).not.toContain('You are an agent')
    expect(out).not.toContain('## System')
    expect(out).toContain('## User')
  })

  test('startedAt undefined → unknown', () => {
    const out = exportSessionToMarkdown([], { ...meta, startedAt: undefined })
    expect(out).toContain('- started: unknown')
  })

  test('startedAt defined → ISO date', () => {
    const out = exportSessionToMarkdown([], meta)
    expect(out).toContain('- started: 2026-01-01T12:00:00.000Z')
  })
})
