import { describe, test, expect } from 'bun:test'
import { buildCliTool } from './build-tool.js'
import { computePerToolSchemaTokens } from '../usage/tracker.js'
import type { CliToolConfig } from '../config/types.js'

const baseCtx = {
  cwd: '/tmp',
  toolTimeoutMs: 1000,
  askUser: async () => 'ok',
}

describe('buildCliTool', () => {
  test('name matches entry key', () => {
    const tool = buildCliTool('gh', { command: 'gh', description: 'GitHub CLI' })
    expect(tool.name).toBe('gh')
  })

  test('description short passes through unchanged', () => {
    const tool = buildCliTool('gh', { command: 'gh', description: 'GitHub CLI' })
    expect(tool.description).toBe('GitHub CLI')
  })

  test('description longer than 200 chars is truncated with ellipsis', () => {
    const long = 'x'.repeat(300)
    const tool = buildCliTool('gh', { command: 'gh', description: long })
    expect(tool.description.length).toBeLessThanOrEqual(200)
    expect(tool.description.endsWith('…')).toBe(true)
  })

  test('rawInputSchema matches the { args: string } shape (decision 2)', () => {
    const tool = buildCliTool('gh', { command: 'gh', description: 'gh' })
    expect(tool.rawInputSchema).toEqual({
      type: 'object',
      properties: {
        args: { type: 'string' },
      },
      required: ['args'],
    })
  })

  test('inputSchema validates { args: string }', () => {
    const tool = buildCliTool('gh', { command: 'gh', description: 'gh' })
    expect(() => tool.inputSchema.parse({ args: 'status' })).not.toThrow()
    expect(() => tool.inputSchema.parse({ args: 123 })).toThrow()
  })

  test('schema token cost is <=40 for a typical entry (target ~30)', () => {
    const tool = buildCliTool('gh', {
      command: 'gh',
      description: 'GitHub CLI for repos, PRs, issues',
    })
    const entries = computePerToolSchemaTokens([tool])
    expect(entries[0]!.tokens).toBeLessThanOrEqual(40)
  })

  test('execute() returns clean zod error for missing args field', async () => {
    const tool = buildCliTool('gh', { command: 'gh', description: 'gh' })
    const result = await tool.execute({ wrong: 'field' }, baseCtx as any)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Invalid arguments/)
  })

  test('execute() rejects metachar args via dispatch (no spawn)', async () => {
    // Delegation test: dispatch's validator runs, so metachar shows up as error
    const tool = buildCliTool('gh', { command: 'gh', description: 'gh' })
    const result = await tool.execute(
      { args: 'pr list; rm -rf /' },
      { ...baseCtx, mode: 'yolo' } as any,
    )
    expect(result.isError).toBe(true)
    expect(result.content.toLowerCase()).toContain('reject')
  })
})
