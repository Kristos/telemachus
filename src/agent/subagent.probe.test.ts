/**
 * SAND-02 (Phase 62, BACKLOG 999.15): runSubagent fail-loud integration test.
 *
 * Verifies the sandbox probe fires at runSubagent entry and returns a
 * SubagentResult with a descriptive error when HOME is empty — without
 * dispatching a single tool.
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { runSubagent, type SubagentParent } from './subagent.js'
import type { Provider, Message, StreamOptions, APIToolSchema } from '../providers/types.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'
import * as sandboxProbe from '../security/sandbox-probe.js'

interface FakeProvider extends Provider {
  calls: Array<{ messages: Message[]; tools: APIToolSchema[]; opts: StreamOptions }>
}

function makeFakeProvider(): FakeProvider {
  const calls: FakeProvider['calls'] = []
  return {
    name: 'fake',
    calls,
    async stream(messages, tools, opts) {
      calls.push({ messages, tools, opts })
      return {
        text: 'ok',
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
    sessionId: 'sand-02-probe-test',
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

describe('runSubagent SAND-02 probe integration (Phase 62, 999.15)', () => {
  const spies: Array<{ mockRestore(): void }> = []

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore()
  })

  test('returns error and does not invoke provider when probe fails', async () => {
    const probeSpy = spyOn(sandboxProbe, 'probeSandbox').mockReturnValue({
      pass: false,
      home: '',
      cwd: '/',
      reason: 'HOME is empty — homedir() returned empty',
    })
    spies.push(probeSpy)

    const provider = makeFakeProvider()
    const parent = makeParent(provider)

    const result = await runSubagent(parent, 'test prompt')

    expect(result.error).not.toBeNull()
    expect(result.error!.message).toContain('sandbox_probe failed')
    expect(result.error!.message).toContain('SAND-02')
    // Provider must NOT have been called — probe aborts before tool dispatch
    expect(provider.calls).toHaveLength(0)
    // messages array is empty — subagent never even constructed initial messages
    expect(result.messages).toHaveLength(0)
  })

  test('proceeds normally when probe passes (happy path)', async () => {
    // No spy needed — real probe runs against real repo cwd (has .git).
    // If the repo is clean, probe passes and the loop proceeds.
    const provider = makeFakeProvider()
    const parent = makeParent(provider)

    const result = await runSubagent(parent, 'test prompt')

    // provider.stream was called at least once
    expect(provider.calls.length).toBeGreaterThan(0)
    expect(result.error).toBeNull()
  })
})
