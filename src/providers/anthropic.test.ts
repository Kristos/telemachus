import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { AnthropicProvider } from './anthropic'
import { StreamAbortError } from './types'

// --- helpers -----------------------------------------------------------

function makeProvider() {
  return new AnthropicProvider('test-key', 'claude-3-5-haiku-20241022')
}

/**
 * Builds a stub async iterable that yields `events`, then throws at `throwAt` index.
 * If `throwAt` is undefined, throws after all events are yielded.
 */
function makeStubStream(events: unknown[], throwAt?: number) {
  const throwIndex = throwAt ?? events.length
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i++) {
        if (i === throwIndex) throw new Error('stream interrupted')
        yield events[i]
      }
      // Throw after all events if throwIndex >= events.length
      if (throwIndex >= events.length) {
        throw new Error('stream interrupted at end')
      }
    },
    finalMessage: async () => { throw new Error('never reached') },
  }
}

function makeCompleteStream(events: unknown[], finalMsg: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
    finalMessage: async () => finalMsg,
  }
}

const spies: ReturnType<typeof spyOn>[] = []

afterEach(() => {
  spies.forEach(s => s.mockRestore())
  spies.length = 0
})

// --- StreamAbortError class tests ---

describe('StreamAbortError', () => {
  test('1: carries partialUsage and cause', () => {
    const partialUsage = { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 }
    const cause = new Error('network')
    const err = new StreamAbortError('x', partialUsage, cause)

    expect(err.partialUsage.inputTokens).toBe(10)
    expect(err.partialUsage.outputTokens).toBe(5)
    expect((err.cause as Error).message).toBe('network')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof StreamAbortError).toBe(true)
    expect(err.name).toBe('StreamAbortError')
  })

  test('2: preserves original error via .cause (Node standard)', () => {
    const original = new Error('original error')
    const err = new StreamAbortError('wrapper', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, original)
    expect(err.cause).toBe(original)
  })
})

// --- Anthropic provider partial-usage capture tests ---

describe('AnthropicProvider partial usage on abort', () => {
  test('3: input_tokens captured from message_start before abort', async () => {
    const provider = makeProvider()
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ]
    const stub = makeStubStream(events, 1) // throw after yielding 1 event

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(42)
    }
  })

  test('4: output_tokens captured from last message_delta before abort', async () => {
    const provider = makeProvider()
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 10 } },
      { type: 'message_delta', usage: { output_tokens: 25 } },
    ]
    const stub = makeStubStream(events, 4) // throw after yielding all 4

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(42)
      expect((err as StreamAbortError).partialUsage.outputTokens).toBe(25)
    }
  })

  test('5: cache tokens captured from message_start', async () => {
    const provider = makeProvider()
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } },
    ]
    const stub = makeStubStream(events, 1)

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.cacheCreationTokens).toBe(100)
      expect((err as StreamAbortError).partialUsage.cacheReadTokens).toBe(50)
    }
  })

  test('6: zero-event abort — partialUsage is all zeros', async () => {
    const provider = makeProvider()
    const stub = makeStubStream([], 0) // throw immediately

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(0)
      expect((err as StreamAbortError).partialUsage.outputTokens).toBe(0)
      expect((err as StreamAbortError).partialUsage.cacheCreationTokens).toBe(0)
      expect((err as StreamAbortError).partialUsage.cacheReadTokens).toBe(0)
    }
  })

  test('7: successful stream does NOT throw StreamAbortError', async () => {
    const provider = makeProvider()
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
    ]
    const finalMsg = {
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello' }],
    }
    const stub = makeCompleteStream(events, finalMsg)

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    const chunks: string[] = []
    const result = await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: (c) => chunks.push(c) })

    expect(result).toBeDefined()
    expect(result.text).toBe('hello')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })
})

// --- CACHE-01 system caching tests (Phase 64 Plan 01) ---

describe('AnthropicProvider CACHE-01 system caching', () => {
  function makeSonnetProvider() {
    return new AnthropicProvider('test-key', 'claude-sonnet-4-5-20250929')
  }

  function makeMinimalCompleteStream() {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 1 } },
    ]
    const finalMsg = {
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '' }],
    }
    return makeCompleteStream(events, finalMsg)
  }

  test('8: stream() attaches cache_control to system block when prompt exceeds Sonnet threshold', async () => {
    const provider = makeSonnetProvider()
    const longPrompt = 'a'.repeat(5000) // ~1250 tokens — above 1024
    const stub = makeMinimalCompleteStream()

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], [], {
      onTextChunk: () => {},
      systemPrompt: longPrompt,
    })

    const callArgs = spy.mock.calls[0]![0] as { system: unknown }
    expect(Array.isArray(callArgs.system)).toBe(true)
    const systemArr = callArgs.system as Array<{ type: string; text: string; cache_control: { type: string } }>
    expect(systemArr).toHaveLength(1)
    expect(systemArr[0]).toEqual({
      type: 'text',
      text: longPrompt,
      cache_control: { type: 'ephemeral' },
    })
  })

  test('9: stream() passes raw string system when prompt is below threshold', async () => {
    const provider = makeSonnetProvider()
    const shortPrompt = 'a'.repeat(100) // ~25 tokens — below 1024
    const stub = makeMinimalCompleteStream()

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], [], {
      onTextChunk: () => {},
      systemPrompt: shortPrompt,
    })

    const callArgs = spy.mock.calls[0]![0] as { system: unknown }
    expect(callArgs.system).toBe(shortPrompt)
  })

  test('10: stream() omits system field entirely when systemPrompt is undefined', async () => {
    const provider = makeSonnetProvider()
    const stub = makeMinimalCompleteStream()

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], [], {
      onTextChunk: () => {},
    })

    const callArgs = spy.mock.calls[0]![0] as Record<string, unknown>
    expect('system' in callArgs ? callArgs.system : undefined).toBeUndefined()
  })
})

// --- CACHE-02 tools caching tests (Phase 64 Plan 02) ---

describe('AnthropicProvider CACHE-02 tools caching', () => {
  function makeSonnetProvider() {
    return new AnthropicProvider('test-key', 'claude-sonnet-4-5-20250929')
  }

  function makeMinimalCompleteStream() {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'message_delta', usage: { output_tokens: 1 } },
    ]
    const finalMsg = {
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '' }],
    }
    return makeCompleteStream(events, finalMsg)
  }

  function makeFatTool(name: string, descSize: number) {
    return {
      name,
      description: 'x'.repeat(descSize),
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, k) => [`prop_${k}`, { type: 'string', description: 'y'.repeat(100) }]),
        ),
      },
    }
  }

  test('11: stream() attaches cache_control to last tool when tools JSON exceeds Sonnet threshold (standard path)', async () => {
    const provider = makeSonnetProvider()
    const tools = [
      makeFatTool('tool_0', 2000),
      makeFatTool('tool_1', 2000),
      makeFatTool('tool_2', 2000),
      makeFatTool('tool_3', 2000),
      makeFatTool('tool_4', 2000),
    ]
    const stub = makeMinimalCompleteStream()

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], tools, { onTextChunk: () => {} })

    const callArgs = spy.mock.calls[0]![0] as { tools: Array<{ name: string; cache_control?: { type: string } }> }
    expect(callArgs.tools).toHaveLength(5)
    expect(callArgs.tools[callArgs.tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(callArgs.tools.slice(0, -1).every(t => !('cache_control' in t))).toBe(true)
  })

  test('12: stream() passes tools unchanged when below threshold (standard path)', async () => {
    const provider = makeSonnetProvider()
    const tools = [
      { name: 'a', description: 'tiny', inputSchema: { type: 'object', properties: {} } },
      { name: 'b', description: 'tiny', inputSchema: { type: 'object', properties: {} } },
    ]
    const stub = makeMinimalCompleteStream()

    const spy = spyOn((provider as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream').mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], tools, { onTextChunk: () => {} })

    const callArgs = spy.mock.calls[0]![0] as { tools: Array<{ name: string; cache_control?: { type: string } }> }
    expect(callArgs.tools).toHaveLength(2)
    expect(callArgs.tools.every(t => !('cache_control' in t))).toBe(true)
  })

  test('13: stream() attaches cache_control to the web_search server tool when beta path tools exceed threshold', async () => {
    const provider = makeSonnetProvider()
    const tools = [
      makeFatTool('tool_0', 2000),
      makeFatTool('tool_1', 2000),
      makeFatTool('tool_2', 2000),
      makeFatTool('tool_3', 2000),
      { name: 'web_search', description: 'server', inputSchema: {}, isServerTool: true },
    ]
    const stub = makeMinimalCompleteStream()

    const spy = spyOn(
      (provider as unknown as { client: { beta: { messages: { stream: unknown } } } }).client.beta.messages,
      'stream',
    ).mockResolvedValue(stub as never)
    spies.push(spy)

    await provider.stream([{ role: 'user', content: 'hi' }], tools, { onTextChunk: () => {} })

    const callArgs = spy.mock.calls[0]![0] as { tools: Array<{ name: string; type?: string; cache_control?: { type: string } }> }
    // Expected: 4 converted regular tools + 1 beta web_search = 5 entries
    expect(callArgs.tools).toHaveLength(5)
    const lastTool = callArgs.tools[callArgs.tools.length - 1]!
    expect(lastTool.name).toBe('web_search')
    expect(lastTool.cache_control).toEqual({ type: 'ephemeral' })
  })
})
