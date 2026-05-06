import { describe, test, expect } from 'bun:test'
import { runAgentLoop, type LoopOptions } from '../../src/agent/loop.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import type {
  Provider,
  Message,
  APIToolSchema,
  StreamOptions,
  StreamResponse,
  TurnUsage,
} from '../../src/providers/types.js'
import type { ToolContext } from '../../src/tools/types.js'
import type { ExitReason } from '../../src/agent-runner/caps.js'

// Minimal stub provider: always returns a single fake tool call per turn so
// the loop keeps going. Optional `delayMs` lets the wall-clock cap trip.
function makeStubProvider(opts: {
  usage?: TurnUsage
  delayMs?: number
}): Provider {
  const usage: TurnUsage = opts.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }
  let callCount = 0
  return {
    name: 'stub',
    async stream(
      _messages: Message[],
      _tools: APIToolSchema[],
      _streamOpts: StreamOptions,
    ): Promise<StreamResponse> {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const id = `call_${++callCount}`
      return {
        text: '',
        toolCalls: [
          { id, name: 'nonexistent_tool', input: {} },
        ],
        usage,
        stopReason: null,
      }
    },
  }
}

function makeToolContext(): ToolContext {
  return {
    cwd: '/tmp',
    toolTimeoutMs: 1000,
    askUser: async () => 'no',
  }
}

function makeOpts(over: Partial<LoopOptions> = {}): LoopOptions {
  const registry = new ToolRegistry()
  return {
    provider: makeStubProvider({}),
    tools: [],
    registry,
    apiSchemas: [],
    maxIterations: 1000, // high ceiling so other caps trip first
    temperature: 0.7,
    windowSize: 40,
    toolContext: makeToolContext(),
    callbacks: {
      onTextChunk: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
    },
    ...over,
  }
}

describe('runAgentLoop caps (Phase 22-01)', () => {
  test('maxIterations=3 → onExit(max_iterations) after 3 turns', async () => {
    const reasons: ExitReason[] = []
    const opts = makeOpts({
      maxIterations: 3,
      onExit: (r) => reasons.push(r),
    })
    await runAgentLoop([{ role: 'user', content: 'go' }], opts)
    expect(reasons).toEqual(['max_iterations'])
  })

  test('maxWallClockMs=50 with 30ms/turn → onExit(max_wall_clock)', async () => {
    const reasons: ExitReason[] = []
    const opts = makeOpts({
      provider: makeStubProvider({ delayMs: 30 }),
      maxIterations: 1000,
      maxWallClockMs: 50,
      onExit: (r) => reasons.push(r),
    })
    await runAgentLoop([{ role: 'user', content: 'go' }], opts)
    expect(reasons).toEqual(['max_wall_clock'])
  })

  test('maxTotalTokens=100 with 60 tokens/turn → onExit(max_total_tokens)', async () => {
    const reasons: ExitReason[] = []
    const opts = makeOpts({
      provider: makeStubProvider({
        usage: {
          inputTokens: 30,
          outputTokens: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      maxIterations: 1000,
      maxTotalTokens: 100,
      onExit: (r) => reasons.push(r),
    })
    await runAgentLoop([{ role: 'user', content: 'go' }], opts)
    expect(reasons).toEqual(['max_total_tokens'])
  })

  test('natural termination → onExit(natural)', async () => {
    const reasons: ExitReason[] = []
    // Provider that returns no tool calls on first turn → natural break.
    const natProvider: Provider = {
      name: 'nat',
      async stream(): Promise<StreamResponse> {
        return {
          text: 'done',
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          stopReason: 'end_turn',
        }
      },
    }
    const opts = makeOpts({
      provider: natProvider,
      onExit: (r) => reasons.push(r),
    })
    await runAgentLoop([{ role: 'user', content: 'hi' }], opts)
    expect(reasons).toEqual(['natural'])
  })
})
