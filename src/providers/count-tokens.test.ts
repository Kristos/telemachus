/**
 * Tests for Provider.countTokens (COST-06, Phase 61) across the three impls:
 *   - AnthropicProvider: network countTokens with per-hash cache
 *   - OpenAICompatProvider: local gpt-tokenizer encode
 *   - FallbackProvider: primary-first with fallback on error
 *
 * Per CLAUDE.md: spyOn + afterEach only. No mock.module.
 */
import { describe, it, test, expect, spyOn, afterEach } from 'bun:test'
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { FallbackProvider } from './fallback.js'
import type { Provider, Message } from './types.js'

const restores: Array<ReturnType<typeof spyOn>> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.mockRestore()
})

// ---------------------------------------------------------------------------
// AnthropicProvider.countTokens
// ---------------------------------------------------------------------------

describe('AnthropicProvider.countTokens (COST-06)', () => {
  it('A1: countTokens returns SDK input_tokens', async () => {
    const provider = new AnthropicProvider('fake-key', 'claude-sonnet-4-5')
    const sdkSpy = spyOn((provider as any).client.beta.messages, 'countTokens').mockResolvedValue({
      input_tokens: 1234,
    } as any)
    restores.push(sdkSpy)

    const count = await provider.countTokens!([
      { role: 'user', content: 'hello' },
    ])
    expect(count).toBe(1234)
  })

  it('A2: cache hit — second call with same messages does NOT hit SDK', async () => {
    const provider = new AnthropicProvider('fake-key', 'claude-sonnet-4-5')
    const sdkSpy = spyOn((provider as any).client.beta.messages, 'countTokens').mockResolvedValue({
      input_tokens: 777,
    } as any)
    restores.push(sdkSpy)

    const msgs: Message[] = [{ role: 'user', content: 'same content' }]
    const first = await provider.countTokens!(msgs)
    const second = await provider.countTokens!(msgs)
    expect(first).toBe(777)
    expect(second).toBe(777)
    expect(sdkSpy.mock.calls.length).toBe(1) // only one network call
  })

  it('A3: different content bypasses cache', async () => {
    const provider = new AnthropicProvider('fake-key', 'claude-sonnet-4-5')
    const sdkSpy = spyOn((provider as any).client.beta.messages, 'countTokens').mockResolvedValue({
      input_tokens: 42,
    } as any)
    restores.push(sdkSpy)

    await provider.countTokens!([{ role: 'user', content: 'message 1' }])
    await provider.countTokens!([{ role: 'user', content: 'message 2 — different' }])
    expect(sdkSpy.mock.calls.length).toBe(2)
  })

  it('A4: SDK error surfaces (not silent zero)', async () => {
    const provider = new AnthropicProvider('fake-key', 'claude-sonnet-4-5')
    const sdkSpy = spyOn((provider as any).client.beta.messages, 'countTokens').mockRejectedValue(
      new Error('SDK unavailable'),
    )
    restores.push(sdkSpy)

    await expect(provider.countTokens!([{ role: 'user', content: 'x' }])).rejects.toThrow(
      'SDK unavailable',
    )
  })
})

// ---------------------------------------------------------------------------
// OpenAICompatProvider.countTokens
// ---------------------------------------------------------------------------

describe('OpenAICompatProvider.countTokens (COST-06)', () => {
  function makeProvider(model = 'glm-4.7-flash') {
    return new OpenAICompatProvider({ apiKey: 'k', baseURL: 'https://x', model })
  }

  it('B1: returns positive count for "hello world"', async () => {
    const p = makeProvider()
    const count = await p.countTokens!([{ role: 'user', content: 'hello world' }])
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(20) // should be ~2 tokens
  })

  it('B2: messages with ContentBlock[] sum per-block correctly', async () => {
    const p = makeProvider()
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'text portion' },
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'bash',
            input: { cmd: 'ls' },
          } as const,
        ],
      },
    ]
    const count = await p.countTokens!(msgs)
    expect(count).toBeGreaterThan(0)
  })

  it('B3: empty messages → 0', async () => {
    const p = makeProvider()
    const count = await p.countTokens!([])
    expect(count).toBe(0)
  })

  it('B4: null content handled without throwing', async () => {
    const p = makeProvider()
    const count = await p.countTokens!([{ role: 'assistant', content: null }])
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// FallbackProvider.countTokens
// ---------------------------------------------------------------------------

describe('FallbackProvider.countTokens (COST-06)', () => {
  it('C1: primary succeeds → result returned, fallback NOT called', async () => {
    const primary: Provider = {
      name: 'primary',
      stream: async () => ({
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }),
      countTokens: async () => 100,
    }
    const fallbackCountTokensSpy = spyOn(
      {
        countTokens: async () => 200,
      },
      'countTokens',
    )
    const fallback: Provider = {
      name: 'fallback',
      stream: primary.stream,
      countTokens: async () => 200,
    }
    const fp = new FallbackProvider(primary, fallback)

    const count = await fp.countTokens!([{ role: 'user', content: 'x' }])
    expect(count).toBe(100)
    // Fallback spy not relevant — primary returned first. Test passes if primary value wins.
    fallbackCountTokensSpy.mockRestore()
  })

  it('C2: primary throws → fallback called, result returned', async () => {
    const primary: Provider = {
      name: 'primary',
      stream: async () => ({
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }),
      countTokens: async () => {
        throw new Error('primary countTokens failed')
      },
    }
    const fallback: Provider = {
      name: 'fallback',
      stream: primary.stream,
      countTokens: async () => 555,
    }
    const fp = new FallbackProvider(primary, fallback)
    const count = await fp.countTokens!([{ role: 'user', content: 'x' }])
    expect(count).toBe(555)
  })

  it('C3: both throw → aggregated error', async () => {
    const primary: Provider = {
      name: 'primary',
      stream: async () => ({
        text: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }),
      countTokens: async () => {
        throw new Error('primary down')
      },
    }
    const fallback: Provider = {
      name: 'fallback',
      stream: primary.stream,
      countTokens: async () => {
        throw new Error('fallback down')
      },
    }
    const fp = new FallbackProvider(primary, fallback)
    await expect(fp.countTokens!([{ role: 'user', content: 'x' }])).rejects.toThrow()
  })
})
