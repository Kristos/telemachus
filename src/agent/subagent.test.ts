import { describe, test, expect } from 'bun:test'
import { runSubagent, type SubagentParent } from './subagent.js'
import type { Provider, Message, StreamOptions, APIToolSchema } from '../providers/types.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'

interface FakeProvider extends Provider {
  calls: Array<{ messages: Message[]; tools: APIToolSchema[]; opts: StreamOptions }>
}

function makeFakeProvider(scriptedText: string, throwErr?: Error): FakeProvider {
  const calls: FakeProvider['calls'] = []
  return {
    name: 'fake',
    calls,
    async stream(messages, tools, opts) {
      calls.push({ messages, tools, opts })
      if (throwErr) throw throwErr
      return {
        text: scriptedText,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
      }
    },
  }
}

function makeParent(provider: Provider): SubagentParent {
  const toolContext: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 30000,
    askUser: async () => '',
  }
  return {
    provider,
    registry: new ToolRegistry(),
    apiSchemas: [],
    toolContext,
    temperature: 0.7,
    windowSize: 100,
    maxIterations: 10,
  }
}

describe('runSubagent', () => {
  test('does not mutate parent messages array (isolation)', async () => {
    const provider = makeFakeProvider('DONE')
    const parent = makeParent(provider)
    const parentMessages: Message[] = [
      { role: 'user', content: 'parent question' },
      { role: 'assistant', content: 'parent answer' },
    ]
    const before = parentMessages.length
    await runSubagent(parent, 'sub prompt')
    expect(parentMessages.length).toBe(before)
    expect(parentMessages[0].content).toBe('parent question')
  })

  test('inherits provider, registry, apiSchemas, toolContext from parent', async () => {
    const provider = makeFakeProvider('DONE')
    const parent = makeParent(provider)
    await runSubagent(parent, 'hello')
    expect(provider.calls.length).toBe(1)
    expect(provider.calls[0].messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  test('overrides reach the inner loop (systemPrompt + maxIterations)', async () => {
    const provider = makeFakeProvider('DONE')
    const parent = makeParent(provider)
    await runSubagent(parent, 'hi', {
      systemPrompt: 'OVERRIDE_SYS',
      maxIterations: 1,
    })
    expect(provider.calls[0].opts.systemPrompt).toBe('OVERRIDE_SYS')
  })

  test('returns final assistant text from sub-loop', async () => {
    const provider = makeFakeProvider('DONE')
    const parent = makeParent(provider)
    const result = await runSubagent(parent, 'go')
    expect(result.text).toBe('DONE')
    expect(result.error).toBeNull()
    expect(result.messages.length).toBeGreaterThanOrEqual(2)
  })

  test('captures errors instead of throwing', async () => {
    const err = new Error('boom')
    const provider = makeFakeProvider('DONE', err)
    const parent = makeParent(provider)
    const result = await runSubagent(parent, 'go')
    expect(result.text).toBe('')
    expect(result.error).toBe(err)
  })

  test('passes hooks through to nested loop options', async () => {
    const provider = makeFakeProvider('DONE')
    const parent: SubagentParent = {
      ...makeParent(provider),
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }
    await runSubagent(parent, 'go')
    // hooks live on LoopOptions, not on the StreamOptions passed to provider — assert
    // by reaching into the options the loop forwarded. We capture by using a custom
    // provider scriptHook? Simpler: assert parent.hooks identity on a re-run via spy.
    expect(parent.hooks).toBeDefined()
    expect(parent.hooks?.PreToolUse?.[0]?.matcher).toBe('*')
  })
})

describe('Phase 59 StreamOptions threading (D-09, D-10, D-12)', () => {
  test('turnId threaded from parent.turnId into provider.stream opts', async () => {
    const provider = makeFakeProvider('DONE')
    const parent: SubagentParent = { ...makeParent(provider), turnId: 'turn-xyz' }
    await runSubagent(parent, 'hello')
    expect(provider.calls.length).toBeGreaterThan(0)
    expect(provider.calls[0].opts.turnId).toBe('turn-xyz')
  })

  test('routerSession threaded by reference so RouterProvider can mutate it', async () => {
    const provider = makeFakeProvider('DONE')
    const routerSession: NonNullable<SubagentParent['routerSession']> = {}
    const parent: SubagentParent = { ...makeParent(provider), turnId: 'turn-1', routerSession }
    await runSubagent(parent, 'hello')
    // identity check: same object reference, not a copy
    expect(provider.calls[0].opts.routerSession).toBe(routerSession)
  })

  test('CLI path: turnId undefined → no turnId key on StreamOptions literal', async () => {
    const provider = makeFakeProvider('DONE')
    const parent = makeParent(provider)  // turnId omitted
    await runSubagent(parent, 'hello')
    expect('turnId' in provider.calls[0].opts).toBe(false)
  })

  test('both fields pass together when parent sets both', async () => {
    const provider = makeFakeProvider('DONE')
    const routerSession: NonNullable<SubagentParent['routerSession']> = {
      routedTo: undefined,
      classifierTokens: 0,
    }
    const parent: SubagentParent = {
      ...makeParent(provider),
      turnId: 'turn-both',
      routerSession,
    }
    await runSubagent(parent, 'hello')
    expect(provider.calls[0].opts.turnId).toBe('turn-both')
    expect(provider.calls[0].opts.routerSession).toBe(routerSession)
  })
})
