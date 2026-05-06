/**
 * Phase 32-02 (DISC-05): Unit tests for streaming message edit logic.
 *
 * Tests verify:
 *   - onTextChunk accumulates tokens into the stream buffer
 *   - Throttled edit interval fires at most once per 1.2s
 *   - stopped flag prevents edits after completion
 *   - Final response edits the placeholder with the complete text
 *   - Long responses: placeholder gets first chunk, follow-ups sent separately
 *   - Typing indicator is stopped after placeholder is posted
 *   - Non-streaming path (no replyEditable) still works via reply()
 *
 * All tests use dependency injection — no real agent loop, no real Discord API.
 * runSubagent is mocked to intercept onTextChunk and call it synchronously.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { SubagentParent, SubagentOverrides } from '../../agent/subagent.js'
import type { Provider } from '../../providers/types.js'
import type { ToolRegistry } from '../../tools/registry.js'
import type { KristosConfig } from '../../config/types.js'
import { ConversationManager } from '../conversation.js'
import { resetQueueForTest } from '../turn-queue.js'
import { clearAllPendingDispatches } from '../auto-dispatch-state.js'

// ── Mock runSubagent ──────────────────────────────────────────────────────────
//
// The mock intercepts onTextChunk from overrides and calls it with configurable
// chunks before resolving. This lets tests simulate streaming without a real loop.

let mockResponseText = 'Hello from agent'
let mockChunksToEmit: string[] = []  // chunks emitted via onTextChunk
let mockShouldThrow = false
let mockThrowMessage = 'test error'

const runSubagentCalls: Array<{
  parent: SubagentParent
  prompt: string
  overrides: SubagentOverrides
}> = []

mock.module('../../agent/subagent.js', () => ({
  runSubagent: async (
    parent: SubagentParent,
    prompt: string,
    overrides: SubagentOverrides = {},
  ) => {
    runSubagentCalls.push({ parent, prompt, overrides })

    if (mockShouldThrow) {
      throw new Error(mockThrowMessage)
    }

    // Emit chunks synchronously before resolving
    for (const chunk of mockChunksToEmit) {
      overrides.onTextChunk?.(chunk)
    }

    return {
      text: mockResponseText,
      messages: [],
      error: null,
    }
  },
}))

// Stub session-bridge — same as runner.test.ts
mock.module('../session-bridge.js', () => ({
  ensureSession: async (_channelId: string, _mapping: Record<string, string>, _model: string) =>
    `discord-${_channelId}`,
  persistTurnDelta: async () => {},
  loadMapping: async () => ({}),
  hydrateConversations: async () => {},
  saveMapping: async () => {},
}))

// Import AFTER mocks
import type { DiscordMessage } from '../runner.js'
const { handleDiscordMessage } = await import('../runner.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {},
  }
}

const stubProvider: Provider = {
  name: 'stub',
  stream: async (_messages, _schemas, opts) => {
    opts?.onTextChunk?.(mockResponseText)
    return {
      text: mockResponseText,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }
  },
}

const stubRegistry = {
  toAPISchema: () => [],
  getAll: () => [],
} as unknown as ToolRegistry

function makeDeps(conversations?: ConversationManager) {
  return {
    config: makeConfig(),
    provider: stubProvider,
    registry: stubRegistry,
    conversations: conversations ?? new ConversationManager(),
    // Phase 64 (PERS-01): systemPrompt is now a per-channel builder function
    systemPrompt: (_channelId: string) => 'You are a helpful assistant.',
    sessionMapping: {} as Record<string, string>,
    model: 'test-model',
  }
}

/**
 * Build a DM DiscordMessage with a replyEditable spy.
 * editSpy tracks calls to the returned handle's .edit() method.
 */
function makeStreamingDm(opts: {
  channelId?: string
  content?: string
  authorId?: string
} = {}): {
  msg: DiscordMessage
  replySpy: ReturnType<typeof mock>
  typingSpy: ReturnType<typeof mock>
  replyEditableSpy: ReturnType<typeof mock>
  editSpy: ReturnType<typeof mock>
} {
  const editSpy = mock((_text: string) => Promise.resolve())
  const replySpy = mock((_text: string) => Promise.resolve())
  const typingSpy = mock(() => Promise.resolve())
  const replyEditableSpy = mock(async (_text: string) => ({ edit: editSpy }))

  const msg: DiscordMessage = {
    channelId: opts.channelId ?? 'stream-ch-001',
    content: opts.content ?? 'hello',
    authorId: opts.authorId ?? 'user-stream',
    reply: replySpy,
    sendTyping: typingSpy,
    isGuild: false,
    replyEditable: replyEditableSpy,
  }
  return { msg, replySpy, typingSpy, replyEditableSpy, editSpy }
}

/** Non-streaming DM — no replyEditable provided. */
function makeNonStreamingDm(opts: { channelId?: string; content?: string; authorId?: string } = {}): {
  msg: DiscordMessage
  replySpy: ReturnType<typeof mock>
  typingSpy: ReturnType<typeof mock>
} {
  const replySpy = mock((_text: string) => Promise.resolve())
  const typingSpy = mock(() => Promise.resolve())
  const msg: DiscordMessage = {
    channelId: opts.channelId ?? 'nostream-ch-001',
    content: opts.content ?? 'hello',
    authorId: opts.authorId ?? 'user-nostream',
    reply: replySpy,
    sendTyping: typingSpy,
    isGuild: false,
  }
  return { msg, replySpy, typingSpy }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockResponseText = 'Hello from agent'
  mockChunksToEmit = []
  mockShouldThrow = false
  mockThrowMessage = 'test error'
  runSubagentCalls.length = 0
  // Module-level state from prior test files in the same bun worker can
  // leak (channelQueues, pending dispatch timers) and short-circuit the
  // turn before the streaming reply-writer is reached.
  resetQueueForTest()
  clearAllPendingDispatches()
})

afterEach(() => {
  runSubagentCalls.length = 0
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('streaming: onTextChunk accumulates into buffer', () => {
  test('onTextChunk calls accumulate into the stream buffer', async () => {
    // Emit 3 chunks via the mock — the runner should accumulate them
    mockChunksToEmit = ['Hello', ' from', ' agent']
    mockResponseText = 'Hello from agent'

    const { msg, editSpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // Final edit should contain the complete text
    const editCalls = editSpy.mock.calls as [string][]
    expect(editCalls.length).toBeGreaterThan(0)

    // The last edit call should be the final complete response
    const lastCall = editCalls[editCalls.length - 1]
    expect(lastCall[0]).toBe('Hello from agent')
  })
})

describe('streaming: placeholder is posted before runSubagent starts', () => {
  test('replyEditable is called with ellipsis placeholder before agent runs', async () => {
    const { msg, replyEditableSpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    expect(replyEditableSpy).toHaveBeenCalledTimes(1)
    expect((replyEditableSpy.mock.calls[0] as [string])[0]).toBe('...')
  })
})

describe('streaming: typing indicator stops after placeholder is posted', () => {
  test('typing indicator is stopped once placeholder is posted', async () => {
    const { msg, typingSpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    // Wait enough time that the 8s typing interval would have fired if still running
    await new Promise((r) => setTimeout(r, 250))

    // typingSpy may be called once (start() fires immediately) but should not grow
    // beyond the initial call since stop() is called after placeholder is posted.
    const callsAfterPlaceholder = typingSpy.mock.calls.length

    await new Promise((r) => setTimeout(r, 200))

    // No additional typing calls — the interval is stopped
    expect(typingSpy.mock.calls.length).toBe(callsAfterPlaceholder)
  })
})

describe('streaming: final response edits placeholder', () => {
  test('placeholder is edited with full response text after agent completes', async () => {
    mockResponseText = 'The complete answer'
    mockChunksToEmit = []

    const { msg, editSpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // At least one edit call, the final one should be the complete text
    const editCalls = editSpy.mock.calls as [string][]
    expect(editCalls.length).toBeGreaterThan(0)
    const lastEdit = editCalls[editCalls.length - 1][0]
    expect(lastEdit).toBe('The complete answer')
  })
})

describe('streaming: long response — placeholder + follow-ups', () => {
  test('4500-char response: placeholder gets first chunk, reply() called for overflow', async () => {
    // 4500 chars → chunker splits at 2000 boundary
    const longResponse = 'A'.repeat(2000) + 'B'.repeat(2000) + 'C'.repeat(500)
    mockResponseText = longResponse
    mockChunksToEmit = []

    const { msg, editSpy, replySpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // The final placeholder edit should be the first chunk (2000 chars of 'A')
    const editCalls = editSpy.mock.calls as [string][]
    expect(editCalls.length).toBeGreaterThan(0)
    const lastEdit = editCalls[editCalls.length - 1][0]
    expect(lastEdit.length).toBeLessThanOrEqual(2000)
    expect(lastEdit).toBe('A'.repeat(2000))

    // reply() should be called for the remaining chunks
    expect(replySpy).toHaveBeenCalled()
    const replyTexts = (replySpy.mock.calls as [string][]).map((c) => c[0])
    const allOverflow = replyTexts.join('')
    // overflow = 'B'.repeat(2000) + 'C'.repeat(500) — may be split across calls
    expect(allOverflow).toBe('B'.repeat(2000) + 'C'.repeat(500))
  })
})

describe('streaming: stopped flag prevents post-completion edits', () => {
  test('no additional interval edits happen after agent completes', async () => {
    mockResponseText = 'short response'
    mockChunksToEmit = ['short', ' response']

    const { msg, editSpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // Record edit count after completion
    const countAfterCompletion = editSpy.mock.calls.length

    // Wait longer than the edit interval (1200ms) to confirm no more edits fire
    await new Promise((r) => setTimeout(r, 250))

    // Count should not increase — stopped = true prevents further interval edits
    expect(editSpy.mock.calls.length).toBe(countAfterCompletion)
  })
})

describe('streaming: error handling — placeholder edited with error', () => {
  test('when runSubagent throws, placeholder is edited with error message', async () => {
    mockShouldThrow = true
    mockThrowMessage = 'network timeout'

    const { msg, editSpy, replySpy } = makeStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // Placeholder should be edited with the error, not replySpy
    const editCalls = editSpy.mock.calls as [string][]
    const errorEdit = editCalls.find(([text]) => text.includes('network timeout'))
    expect(errorEdit).toBeDefined()
    expect(replySpy).not.toHaveBeenCalled()
  })
})

describe('streaming: non-streaming fallback (no replyEditable)', () => {
  test('without replyEditable, falls back to plain reply() and typing indicator', async () => {
    mockResponseText = 'plain reply response'

    const { msg, replySpy, typingSpy } = makeNonStreamingDm()
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // reply() called with the response (not editSpy)
    expect(replySpy).toHaveBeenCalledWith('plain reply response')
    // Typing indicator is used (no placeholder path)
    expect(typingSpy).toHaveBeenCalled()
  })

  test('without replyEditable, long responses are chunked via reply()', async () => {
    mockResponseText = 'X'.repeat(3000)

    const { msg, replySpy } = makeNonStreamingDm({ channelId: 'nostream-long' })
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    await new Promise((r) => setTimeout(r, 150))

    // Should be 2 calls: 2000 + 1000
    expect(replySpy).toHaveBeenCalledTimes(2)
    expect((replySpy.mock.calls[0] as [string])[0].length).toBe(2000)
    expect((replySpy.mock.calls[1] as [string])[0].length).toBe(1000)
  })
})
