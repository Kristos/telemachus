import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runAgentLoop, type LoopOptions } from './loop'
import { ToolRegistry } from '../tools/registry'
import type { Tool, ToolContext, ToolResult } from '../tools/types'
import type {
  Provider,
  Message,
  StreamResponse,
  StreamOptions,
  APIToolSchema,
  ToolCallBlock,
  TurnUsage,
} from '../providers/types'
import { StreamAbortError } from '../providers/types'
import type { HookConfig, HookEvent, HookRunResult } from '../hooks/index'
import { z } from 'zod'

// --- helpers -----------------------------------------------------------

function makeProvider(scripted: StreamResponse[]): Provider {
  let i = 0
  return {
    name: 'stub',
    async stream(_msgs: Message[], _tools: APIToolSchema[], opts: StreamOptions) {
      const r = scripted[i++] ?? {
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end',
      }
      if (r.text) opts.onTextChunk(r.text)
      return r
    },
  }
}

interface SpyTool extends Tool {
  calls: unknown[]
}

function makeTool(name: string, exec?: (args: unknown) => Promise<ToolResult> | ToolResult): SpyTool {
  const calls: unknown[] = []
  return {
    name,
    description: 'spy tool',
    inputSchema: z.any(),
    calls,
    async execute(args: unknown): Promise<ToolResult> {
      calls.push(args)
      if (exec) return await exec(args)
      return { content: 'ok', isError: false }
    },
  }
}

function makeCallbacks(): {
  onTextChunk: (c: string) => void
  onToolCall: (id: string, name: string, args: unknown) => void
  onToolResult: (id: string, name: string, result: string, isError: boolean) => void
  onTurnComplete: (u: unknown) => void
  onHookWarning: (event: HookEvent, name: string, results: HookRunResult[]) => void
  warnings: Array<{ event: HookEvent; name: string; results: HookRunResult[] }>
  toolResults: Array<{ id: string; name: string; result: string; isError: boolean }>
} {
  const warnings: Array<{ event: HookEvent; name: string; results: HookRunResult[] }> = []
  const toolResults: Array<{ id: string; name: string; result: string; isError: boolean }> = []
  return {
    onTextChunk: () => {},
    onToolCall: () => {},
    onToolResult: (id, name, result, isError) => {
      toolResults.push({ id, name, result, isError })
    },
    onTurnComplete: () => {},
    onHookWarning: (event, name, results) => {
      warnings.push({ event, name, results })
    },
    warnings,
    toolResults,
  }
}

function makeOptions(
  provider: Provider,
  tools: Tool[],
  hooks: HookConfig | undefined,
  cb: ReturnType<typeof makeCallbacks>,
): LoopOptions {
  const registry = new ToolRegistry()
  registry.registerAll(tools)
  const ctx: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 5000,
    askUser: async () => '',
  }
  return {
    provider,
    tools,
    registry,
    apiSchemas: [],
    maxIterations: 5,
    temperature: 0,
    windowSize: 100,
    toolContext: ctx,
    callbacks: {
      onTextChunk: cb.onTextChunk,
      onToolCall: cb.onToolCall,
      onToolResult: cb.onToolResult,
      onTurnComplete: cb.onTurnComplete,
      onHookWarning: cb.onHookWarning,
    },
    hooks,
  }
}

function toolCallTurn(name: string, id = 'tc1'): StreamResponse {
  const tc: ToolCallBlock = { id, name, input: {} }
  return {
    text: '',
    toolCalls: [tc],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: 'tool_use',
  }
}

function textTurn(text = 'done'): StreamResponse {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: 'end',
  }
}

// --- tests -------------------------------------------------------------

describe('runAgentLoop hooks integration', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kc-loop-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('1: no hooks config behaves as before', async () => {
    const tool = makeTool('echo')
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    const opts = makeOptions(provider, [tool], undefined, cb)
    await runAgentLoop([], opts)
    expect(tool.calls.length).toBe(1)
    expect(cb.warnings.length).toBe(0)
  })

  test('2: PreToolUse hook fires before tool.execute', async () => {
    const marker = join(tmp, 'pre-marker')
    let preExistedAtExecute = false
    const tool = makeTool('echo', async () => {
      preExistedAtExecute = existsSync(marker)
      return { content: 'ok', isError: false }
    })
    const hooks: HookConfig = {
      PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: `touch ${marker}` }] }],
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [tool], hooks, cb))
    expect(preExistedAtExecute).toBe(true)
    expect(tool.calls.length).toBe(1)
  })

  test('3: PostToolUse hook fires after tool.execute', async () => {
    const marker = join(tmp, 'tool-side-effect')
    const tool = makeTool('echo', async () => {
      writeFileSync(marker, 'x')
      return { content: 'ok', isError: false }
    })
    const verifyFile = join(tmp, 'verify')
    const hooks: HookConfig = {
      PostToolUse: [
        {
          matcher: 'echo',
          hooks: [{ type: 'command', command: `test -f ${marker} && touch ${verifyFile}` }],
        },
      ],
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [tool], hooks, cb))
    expect(existsSync(verifyFile)).toBe(true)
  })

  test('4: Stop hook fires once after loop ends', async () => {
    const marker = join(tmp, 'stop-marker')
    const hooks: HookConfig = {
      Stop: [{ hooks: [{ type: 'command', command: `echo x >> ${marker}` }] }],
    }
    const provider = makeProvider([textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [], hooks, cb))
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean).length).toBe(1)
  })

  test('5: PreToolUse non-zero blocks tool execution', async () => {
    const tool = makeTool('echo')
    const hooks: HookConfig = {
      PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: 'echo blocked >&2; exit 2' }] }],
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [tool], hooks, cb))
    expect(tool.calls.length).toBe(0)
    expect(cb.toolResults.length).toBe(1)
    expect(cb.toolResults[0]!.isError).toBe(true)
    expect(cb.toolResults[0]!.result).toContain('blocked')
  })

  test('6: PostToolUse non-zero does not block, emits warning', async () => {
    const tool = makeTool('echo')
    const hooks: HookConfig = {
      PostToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: 'exit 3' }] }],
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [tool], hooks, cb))
    expect(tool.calls.length).toBe(1)
    expect(cb.warnings.length).toBe(1)
    expect(cb.warnings[0]!.event).toBe('PostToolUse')
  })

  test('8: MCP dispatch hook calls ensureAlive before executing mcp__ tool', async () => {
    const tool = makeTool('mcp__myserver__do_thing')
    const ensureCalls: string[] = []
    const fakeMcp = {
      ensureAlive: async (name: string) => { ensureCalls.push(name) },
      incrementPending: () => {},
      decrementPending: () => {},
      touch: () => {},
    } as unknown as import('../mcp/manager').McpManager
    const provider = makeProvider([toolCallTurn('mcp__myserver__do_thing'), textTurn()])
    const cb = makeCallbacks()
    const opts = makeOptions(provider, [tool], undefined, cb)
    opts.mcpManager = fakeMcp
    await runAgentLoop([], opts)
    expect(ensureCalls).toEqual(['myserver'])
    expect(tool.calls.length).toBe(1)
  })

  test('9: MCP dispatch hook failure yields error tool-result without crashing', async () => {
    const tool = makeTool('mcp__dead__call')
    const fakeMcp = {
      ensureAlive: async () => { throw new Error('spawn failed') },
      incrementPending: () => {},
      decrementPending: () => {},
      touch: () => {},
    } as unknown as import('../mcp/manager').McpManager
    const provider = makeProvider([toolCallTurn('mcp__dead__call'), textTurn()])
    const cb = makeCallbacks()
    const opts = makeOptions(provider, [tool], undefined, cb)
    opts.mcpManager = fakeMcp
    await runAgentLoop([], opts)
    expect(tool.calls.length).toBe(0)
    expect(cb.toolResults.length).toBe(1)
    expect(cb.toolResults[0]!.isError).toBe(true)
    expect(cb.toolResults[0]!.result).toContain("unavailable")
  })

  test('7: timed-out PreToolUse hook blocks but does not crash loop', async () => {
    const tool = makeTool('echo')
    const hooks: HookConfig = {
      PreToolUse: [
        {
          matcher: 'echo',
          hooks: [{ type: 'command', command: 'sleep 5', timeout: 0.1 as unknown as number }],
        },
      ],
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    const cb = makeCallbacks()
    await runAgentLoop([], makeOptions(provider, [tool], hooks, cb))
    expect(tool.calls.length).toBe(0)
    expect(cb.toolResults.length).toBe(1)
    expect(cb.toolResults[0]!.isError).toBe(true)
  })
})

// --- Phase 55 (USAGE-01): partial usage on stream error ---

describe('runAgentLoop partial usage recording', () => {
  test('5: records partialUsage on StreamAbortError and re-throws', async () => {
    const partialUsage: TurnUsage = { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 }
    const abortError = new StreamAbortError('network down', partialUsage, new Error('ECONNRESET'))

    const stubProvider: Provider = {
      name: 'stub',
      async stream() {
        throw abortError
      },
    }

    const calls: TurnUsage[] = []
    const cb = makeCallbacks()
    cb.onTurnComplete = (u: unknown) => { calls.push(u as TurnUsage) }

    const registry = new ToolRegistry()
    const ctx: ToolContext = { cwd: process.cwd(), toolTimeoutMs: 5000, askUser: async () => '' }
    const opts: LoopOptions = {
      provider: stubProvider,
      tools: [],
      registry,
      apiSchemas: [],
      maxIterations: 5,
      temperature: 0,
      windowSize: 100,
      toolContext: ctx,
      callbacks: {
        onTextChunk: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onTurnComplete: cb.onTurnComplete,
      },
    }

    await expect(runAgentLoop([{ role: 'user', content: 'hi' }], opts))
      .rejects.toBeInstanceOf(StreamAbortError)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(partialUsage)
  })

  test('6: loop re-throws plain Error WITHOUT calling onTurnComplete', async () => {
    const plainError = new Error('something went wrong')

    const stubProvider: Provider = {
      name: 'stub',
      async stream() {
        throw plainError
      },
    }

    const calls: TurnUsage[] = []
    const cb = makeCallbacks()
    cb.onTurnComplete = (u: unknown) => { calls.push(u as TurnUsage) }

    const registry = new ToolRegistry()
    const ctx: ToolContext = { cwd: process.cwd(), toolTimeoutMs: 5000, askUser: async () => '' }
    const opts: LoopOptions = {
      provider: stubProvider,
      tools: [],
      registry,
      apiSchemas: [],
      maxIterations: 5,
      temperature: 0,
      windowSize: 100,
      toolContext: ctx,
      callbacks: {
        onTextChunk: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onTurnComplete: cb.onTurnComplete,
      },
    }

    await expect(runAgentLoop([{ role: 'user', content: 'hi' }], opts))
      .rejects.toEqual(plainError)

    expect(calls).toHaveLength(0)
  })

  test('7: success path still calls onTurnComplete once with full usage', async () => {
    const fullUsage: TurnUsage = { inputTokens: 200, outputTokens: 80, cacheCreationTokens: 10, cacheReadTokens: 5 }

    const stubProvider: Provider = {
      name: 'stub',
      async stream(_msgs, _tools, opts) {
        opts.onTextChunk('hello')
        return {
          text: 'hello',
          toolCalls: [],
          usage: fullUsage,
          stopReason: 'end_turn',
        }
      },
    }

    const calls: TurnUsage[] = []
    const cb = makeCallbacks()
    cb.onTurnComplete = (u: unknown) => { calls.push(u as TurnUsage) }

    const registry = new ToolRegistry()
    const ctx: ToolContext = { cwd: process.cwd(), toolTimeoutMs: 5000, askUser: async () => '' }
    const opts: LoopOptions = {
      provider: stubProvider,
      tools: [],
      registry,
      apiSchemas: [],
      maxIterations: 5,
      temperature: 0,
      windowSize: 100,
      toolContext: ctx,
      callbacks: {
        onTextChunk: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onTurnComplete: cb.onTurnComplete,
      },
    }

    await runAgentLoop([{ role: 'user', content: 'hi' }], opts)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(fullUsage)
  })
})
