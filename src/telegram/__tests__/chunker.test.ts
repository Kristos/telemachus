import { describe, expect, test } from 'bun:test'
import { chunkMessage, MAX_LENGTH } from '../chunker.js'

describe('chunkMessage (TGAGENT-04)', () => {
  test('MAX_LENGTH is 4096', () => {
    expect(MAX_LENGTH).toBe(4096)
  })
  test('short text returns single-element array', () => {
    expect(chunkMessage('hello')).toEqual(['hello'])
  })
  test('exactly 4096 chars returns single chunk', () => {
    const text = 'a'.repeat(4096)
    const chunks = chunkMessage(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.length).toBe(4096)
  })
  test('4097 chars splits into two', () => {
    const text = 'a'.repeat(4097)
    const chunks = chunkMessage(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.length).toBe(4096)
    expect(chunks[1]!.length).toBe(1)
  })
  test('splits at last newline within 4096', () => {
    const head = 'a'.repeat(100) + '\n'
    const tail = 'b'.repeat(5000)
    const chunks = chunkMessage(head + tail)
    // first chunk ends at the '\n' boundary (head)
    expect(chunks[0]!.endsWith('\n')).toBe(true)
    expect(chunks[0]!.length).toBe(101)
    // remaining chunks recombine to the tail
    expect(chunks.slice(1).join('')).toBe(tail)
  })
  test('hard-split at 4096 when no newline in range', () => {
    const text = 'x'.repeat(5000)
    const chunks = chunkMessage(text)
    expect(chunks[0]!.length).toBe(4096)
    expect(chunks[1]!.length).toBe(904)
  })
  test('multi-chunk preserves all original characters', () => {
    const text = 'z'.repeat(10_000)
    const chunks = chunkMessage(text)
    expect(chunks.join('')).toBe(text)
  })
})
