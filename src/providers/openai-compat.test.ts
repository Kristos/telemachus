import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { OpenAICompatProvider } from './openai-compat'
import { StreamAbortError } from './types'

// --- helpers -----------------------------------------------------------

function makeProvider() {
  return new OpenAICompatProvider({ model: 'gpt-4o', apiKey: 'test-key' })
}

function makeOllamaProvider() {
  return new OpenAICompatProvider({ model: 'llama3', isOllama: true })
}

function makeChunkStream(chunks: unknown[], throwAfter?: number) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        if (throwAfter === i) throw new Error('stream aborted')
        yield chunks[i]
      }
      if (throwAfter === undefined || throwAfter >= chunks.length) {
        throw new Error('stream aborted at end')
      }
    },
  }
}

const spies: ReturnType<typeof spyOn>[] = []

afterEach(() => {
  spies.forEach(s => s.mockRestore())
  spies.length = 0
})

// --- OpenAI-compat partial usage tests ---

describe('OpenAICompatProvider partial usage on abort', () => {
  test('1: stream abort mid-chunks — partialUsage is all zeros (no usage chunk seen yet)', async () => {
    const provider = makeProvider()

    // Two content chunks, no usage chunk — then abort
    const chunks = [
      { choices: [{ delta: { content: 'hello' } }], usage: null },
      { choices: [{ delta: { content: ' world' } }], usage: null },
    ]
    // throwAfter=2 means throw after yielding both chunks
    const stubStream = makeChunkStream(chunks, 2)

    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockResolvedValue(stubStream as never)
    spies.push(createSpy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(0)
      expect((err as StreamAbortError).partialUsage.outputTokens).toBe(0)
    }
  })

  test('2: stream abort AFTER usage chunk — partialUsage is populated', async () => {
    const provider = makeProvider()

    const chunks = [
      { choices: [{ delta: { content: 'hello' } }], usage: null },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }, // usage chunk
      // throwAfter=2 means throw when index=2 (after yielding both)
    ]
    const stubStream = makeChunkStream(chunks, 2)

    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockResolvedValue(stubStream as never)
    spies.push(createSpy)

    try {
      await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(20)
      expect((err as StreamAbortError).partialUsage.outputTokens).toBe(10)
    }
  })

  test('3: successful stream unchanged — no StreamAbortError', async () => {
    const provider = makeProvider()

    const chunks = [
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }], usage: null },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]

    // Complete stream — no throw
    const completeStream = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }

    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockResolvedValue(completeStream as never)
    spies.push(createSpy)

    const result = await provider.stream([{ role: 'user', content: 'hi' }], [], { onTextChunk: () => {} })
    expect(result).toBeDefined()
    expect(result.text).toBe('hello')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  test('4: non-streaming Ollama path throws StreamAbortError on client error', async () => {
    // Ollama + tools = non-streaming path
    const provider = makeOllamaProvider()

    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockRejectedValue(new Error('connection refused'))
    spies.push(createSpy)

    const toolSchema = [{ name: 'bash', description: 'run bash', inputSchema: {} }]
    try {
      await provider.stream([{ role: 'user', content: 'hi' }], toolSchema, { onTextChunk: () => {} })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StreamAbortError)
      expect((err as StreamAbortError).partialUsage.inputTokens).toBe(0)
      expect((err as StreamAbortError).partialUsage.outputTokens).toBe(0)
    }
  })
})

// --- responseFormat forwarding (Phase 59 / COMPRESS-06 prerequisite) ---

describe('responseFormat forwarding (Phase 59 / COMPRESS-06 prerequisite)', () => {
  // Uses Ollama + tools path (non-streaming) so mock shape is a plain object.

  test('forwards response_format when opts.responseFormat provided', async () => {
    const provider = makeOllamaProvider()
    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockResolvedValue({
      choices: [{ message: { content: '{"decision":"simple"}', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    } as never)
    spies.push(createSpy)

    const toolSchema = [{ name: 'test', description: 'test', inputSchema: {} }]
    await provider.stream([{ role: 'user', content: 'hi' }], toolSchema, {
      onTextChunk: () => {},
      responseFormat: { type: 'json_object' },
      maxTokens: 10,
    })

    expect(createSpy).toHaveBeenCalledTimes(1)
    const calledWith = createSpy.mock.calls[0][0] as Record<string, unknown>
    expect(calledWith['response_format']).toEqual({ type: 'json_object' })
  })

  test('omits response_format key entirely when opts.responseFormat undefined', async () => {
    const provider = makeOllamaProvider()
    const createSpy = spyOn(
      (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client.chat.completions,
      'create'
    ).mockResolvedValue({
      choices: [{ message: { content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    } as never)
    spies.push(createSpy)

    const toolSchema = [{ name: 'test', description: 'test', inputSchema: {} }]
    await provider.stream([{ role: 'user', content: 'hi' }], toolSchema, {
      onTextChunk: () => {},
    })

    const calledWith = createSpy.mock.calls[0][0] as Record<string, unknown>
    expect('response_format' in calledWith).toBe(false)
  })
})
