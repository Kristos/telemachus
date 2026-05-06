import { describe, it, expect } from 'bun:test'
import { parseSlashCommand, BUILTIN_COMMAND_NAMES } from './dispatcher.js'

describe('parseSlashCommand', () => {
  it('parses a bare command with no arg', () => {
    expect(parseSlashCommand('/cost')).toEqual({ name: 'cost', arg: '' })
  })

  it('parses a command with an absolute path arg', () => {
    expect(parseSlashCommand('/export /tmp/foo.md')).toEqual({
      name: 'export',
      arg: '/tmp/foo.md',
    })
  })

  it('lowercases the command name and trims the arg', () => {
    expect(parseSlashCommand('/Export Foo')).toEqual({
      name: 'export',
      arg: 'Foo',
    })
  })

  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello')).toBeNull()
  })

  it('returns null for a bare slash', () => {
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('exposes all eleven builtin command names', () => {
    const expected = [
      'compact',
      'model',
      'clear',
      'plan',
      'cost',
      'resume',
      'export',
      'mcp',
      'agents',
      'hooks',
    ]
    for (const name of expected) {
      expect(BUILTIN_COMMAND_NAMES).toContain(name)
    }
  })
})
