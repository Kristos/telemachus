import { describe, test, expect } from 'bun:test'
import { taskTool } from './task.js'
import type { ToolContext } from '../types.js'
import type { SubagentParent } from '../../agent/subagent.js'
import type { Provider, Message, StreamOptions, APIToolSchema } from '../../providers/types.js'
import { ToolRegistry } from '../../tools/registry.js'

function makeFakeProvider(scriptedText: string, throwErr?: Error): Provider {
  return {
    name: 'fake',
    async stream(_messages: Message[], _tools: APIToolSchema[], _opts: StreamOptions) {
      if (throwErr) throw throwErr
      return {
        text: scriptedText,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn' as const,
      }
    },
  }
}

function makeParent(provider: Provider): SubagentParent {
  const innerToolContext: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 30000,
    askUser: async () => '',
  }
  return {
    provider,
    registry: new ToolRegistry(),
    apiSchemas: [],
    toolContext: innerToolContext,
    temperature: 0.7,
    windowSize: 100,
    maxIterations: 10,
  }
}

function makeContext(parent?: SubagentParent): ToolContext {
  return {
    cwd: process.cwd(),
    toolTimeoutMs: 30000,
    askUser: async () => '',
    subagentParent: parent,
  }
}

describe('taskTool', () => {
  test('returns isError when subagentParent missing from context', async () => {
    const ctx = makeContext(undefined)
    const result = await taskTool.execute(
      { description: 'test', prompt: 'do something' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('subagentParent')
  })

  test('returns subagent text on success', async () => {
    const provider = makeFakeProvider('RESULT')
    const parent = makeParent(provider)
    const ctx = makeContext(parent)
    const result = await taskTool.execute(
      { description: 'test', prompt: 'do something' },
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toBe('RESULT')
  })

  test('returns isError with prefix when subagent provider throws', async () => {
    const provider = makeFakeProvider('', new Error('boom'))
    const parent = makeParent(provider)
    const ctx = makeContext(parent)
    const result = await taskTool.execute(
      { description: 'test', prompt: 'do something' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Subagent failed:')
    expect(result.content).toContain('boom')
  })

  test('zod validation rejects missing prompt', async () => {
    const provider = makeFakeProvider('RESULT')
    const parent = makeParent(provider)
    const ctx = makeContext(parent)
    const result = await taskTool.execute(
      { description: 'test' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Invalid arguments')
  })
})
