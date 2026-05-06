import { describe, test, expect } from 'bun:test'
import { resolveCacheThreshold, attachSystemCache, maybeCacheToolsArray } from './anthropic-cache'

describe('resolveCacheThreshold', () => {
  test('1: returns 2048 for haiku models', () => {
    expect(resolveCacheThreshold('claude-3-5-haiku-20241022')).toBe(2048)
    expect(resolveCacheThreshold('claude-haiku-4-5')).toBe(2048)
  })

  test('2: returns 1024 for sonnet models', () => {
    expect(resolveCacheThreshold('claude-sonnet-4-5-20250929')).toBe(1024)
    expect(resolveCacheThreshold('claude-3-5-sonnet-20241022')).toBe(1024)
  })

  test('3: returns 1024 for opus models', () => {
    expect(resolveCacheThreshold('claude-opus-4-20250514')).toBe(1024)
    expect(resolveCacheThreshold('claude-opus-4-7-20260101')).toBe(1024)
  })

  test('4: returns 1024 for unknown models (fallthrough)', () => {
    expect(resolveCacheThreshold('gpt-4')).toBe(1024)
    expect(resolveCacheThreshold('')).toBe(1024)
  })
})

describe('attachSystemCache', () => {
  test('5: returns raw string when prompt is below Sonnet threshold', () => {
    const prompt = 'a'.repeat(100) // ~25 tokens — below 1024
    expect(attachSystemCache(prompt, 'claude-sonnet-4-5-20250929')).toBe(prompt)
  })

  test('6: returns raw string when prompt is below Haiku threshold', () => {
    const prompt = 'a'.repeat(4000) // ~1000 tokens — below 2048 haiku threshold
    expect(attachSystemCache(prompt, 'claude-3-5-haiku-20241022')).toBe(prompt)
  })

  test('7: attaches cache_control when prompt exceeds Sonnet threshold', () => {
    const prompt = 'a'.repeat(5000) // ~1250 tokens — above 1024
    const result = attachSystemCache(prompt, 'claude-sonnet-4-5-20250929')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect((result as Array<{ type: string; text: string; cache_control: { type: string } }>)[0]).toEqual({
      type: 'text',
      text: prompt,
      cache_control: { type: 'ephemeral' },
    })
  })

  test('8: attaches cache_control when prompt exceeds Haiku threshold', () => {
    const prompt = 'a'.repeat(9000) // ~2250 tokens — above 2048
    const result = attachSystemCache(prompt, 'claude-haiku-4-5')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect((result as Array<{ type: string; text: string; cache_control: { type: string } }>)[0].cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  test('9: returns empty string passthrough for empty prompt', () => {
    expect(attachSystemCache('', 'claude-sonnet-4-5-20250929')).toBe('')
    expect(attachSystemCache('', 'claude-3-5-haiku-20241022')).toBe('')
  })
})

describe('maybeCacheToolsArray', () => {
  function makeTinyTools(n: number): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return Array.from({ length: n }, (_, i) => ({
      name: `tool_${i}`,
      description: `desc ${i}`,
      input_schema: { type: 'object', properties: {} },
    }))
  }

  function makeFatTools(n: number, descSize: number): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return Array.from({ length: n }, (_, i) => ({
      name: `tool_${i}`,
      description: 'x'.repeat(descSize),
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, k) => [`prop_${k}`, { type: 'string', description: 'y'.repeat(100) }]),
        ),
      },
    }))
  }

  test('10: returns empty array unchanged', () => {
    const result = maybeCacheToolsArray([], 'claude-sonnet-4-5-20250929')
    expect(result).toEqual([])
  })

  test('11: returns tools unchanged when serialized size is below Sonnet threshold', () => {
    const tools = makeTinyTools(3)
    const result = maybeCacheToolsArray(tools, 'claude-sonnet-4-5-20250929')
    expect(result).toBe(tools) // reference-equal — identity preserved
    expect(result.every(t => !('cache_control' in t))).toBe(true)
  })

  test('12: attaches cache_control to last tool when above Sonnet threshold', () => {
    const tools = makeFatTools(5, 2000) // serialized >> 4096 bytes
    const result = maybeCacheToolsArray(tools, 'claude-sonnet-4-5-20250929') as Array<{ name: string; cache_control?: { type: string } }>
    expect(result).toHaveLength(5)
    expect(result[result.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
    // All prior tools must NOT have cache_control
    expect(result.slice(0, -1).every(t => !('cache_control' in t))).toBe(true)
  })

  test('13: uses Haiku threshold (2048) when model contains haiku', () => {
    // Build tools whose serialized size is between sonnet (1024*4=4096) and haiku (2048*4=8192) thresholds.
    // Target 4100-8100 bytes serialized — above sonnet, below haiku.
    const midTools = makeFatTools(3, 500)
    const midSerialized = JSON.stringify(midTools)
    // Verify test setup: must be above sonnet threshold (>=4096) but below haiku (<8192)
    expect(midSerialized.length).toBeGreaterThanOrEqual(4096)
    expect(midSerialized.length).toBeLessThan(8192)

    // Haiku model should NOT attach cache_control (below 2048 token threshold)
    const haikuResult = maybeCacheToolsArray(midTools, 'claude-3-5-haiku-20241022')
    expect(haikuResult.every(t => !('cache_control' in t))).toBe(true)

    // Fatter tools above haiku threshold should attach
    const bigTools = makeFatTools(6, 1000) // well over haiku's 8192-byte threshold
    const bigSerialized = JSON.stringify(bigTools)
    expect(bigSerialized.length).toBeGreaterThanOrEqual(8192)
    const haikuBigResult = maybeCacheToolsArray(bigTools, 'claude-haiku-4-5') as Array<{ name: string; cache_control?: { type: string } }>
    expect(haikuBigResult[haikuBigResult.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
  })
})
