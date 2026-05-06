/**
 * Phase 64 (CACHE-03 / SUCCESS-02a protocol, programmatic override):
 *
 * Per the user's pre-authorized autonomous execution of Phase 64, the live
 * 2-turn CLI checkpoint in 64-03-PLAN.md is replaced with this programmatic
 * spy-based integration test. It scripts two client.messages.stream responses
 * and asserts that the AnthropicProvider returns the correct cacheReadTokens /
 * cacheCreationTokens values on each turn, proving the end-to-end capture path
 * works without a live API key.
 *
 * Live offline verification (user's choice, deferred) would additionally
 * validate that the /cost slash command renders the right numbers — which
 * this test cannot exercise directly because it would require spinning up
 * the CLI TUI. The formatCost unit tests in src/ui/slash/format.test.ts
 * cover the rendering side; this test covers the SDK → TurnUsage capture side.
 */
import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { AnthropicProvider } from './anthropic'

const spies: ReturnType<typeof spyOn>[] = []

afterEach(() => {
  spies.forEach(s => s.mockRestore())
  spies.length = 0
})

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

describe('CACHE-03 SUCCESS-02a protocol — 2-turn cache roundtrip', () => {
  test('Turn 1: cache creation tokens captured; Turn 2: cache read tokens captured', async () => {
    const provider = new AnthropicProvider('test-key', 'claude-sonnet-4-5-20250929')

    // Turn 1: large system prompt creates cache → cache_creation_input_tokens set
    const turn1Events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 22,
            cache_creation_input_tokens: 1215,
            cache_read_input_tokens: 0,
          },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
    ]
    const turn1Final = {
      usage: {
        input_tokens: 22,
        output_tokens: 2,
        cache_creation_input_tokens: 1215,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    }

    // Turn 2: same system prompt hits cache → cache_read_input_tokens set
    const turn2Events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 21,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1215,
          },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok2' } },
      { type: 'message_delta', usage: { output_tokens: 3 } },
    ]
    const turn2Final = {
      usage: {
        input_tokens: 21,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1215,
      },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok2' }],
    }

    const spy = spyOn(
      (provider as unknown as { client: { messages: { stream: unknown } } }).client.messages,
      'stream',
    )
      .mockResolvedValueOnce(makeCompleteStream(turn1Events, turn1Final) as never)
      .mockResolvedValueOnce(makeCompleteStream(turn2Events, turn2Final) as never)
    spies.push(spy)

    // Use a long-enough system prompt so cache_control is attached (exercises
    // the full 64-01 wiring path even though the SDK is mocked).
    const bigSystemPrompt = 'A'.repeat(5000) // ~1250 tokens — above Sonnet threshold

    // --- Turn 1 ---
    const res1 = await provider.stream([{ role: 'user', content: 'hi' }], [], {
      onTextChunk: () => {},
      systemPrompt: bigSystemPrompt,
    })
    expect(res1.usage.cacheCreationTokens).toBe(1215)
    expect(res1.usage.cacheReadTokens).toBe(0)
    expect(res1.usage.inputTokens).toBe(22)
    expect(res1.usage.outputTokens).toBe(2)

    // --- Turn 2 ---
    const res2 = await provider.stream([{ role: 'user', content: 'hi again' }], [], {
      onTextChunk: () => {},
      systemPrompt: bigSystemPrompt,
    })
    expect(res2.usage.cacheReadTokens).toBe(1215)
    expect(res2.usage.cacheCreationTokens).toBe(0)
    expect(res2.usage.inputTokens).toBe(21)
    expect(res2.usage.outputTokens).toBe(3)

    // Confirm the SDK call included cache_control (wiring from 64-01 active)
    const turn1Args = spy.mock.calls[0]![0] as { system: unknown }
    expect(Array.isArray(turn1Args.system)).toBe(true)
    const turn1Sys = turn1Args.system as Array<{ cache_control: { type: string } }>
    expect(turn1Sys[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })
})
