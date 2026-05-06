import { describe, test, expect } from 'bun:test'
import { chunkMessage } from './chunker.js'

describe('chunkMessage', () => {
  test('empty input returns single empty string', () => {
    expect(chunkMessage('')).toEqual([''])
  })

  test('input under 2000 chars returns single-element array', () => {
    const text = 'a'.repeat(1999)
    const result = chunkMessage(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(text)
  })

  test('input of exactly 2000 chars returns single-element array', () => {
    const text = 'a'.repeat(2000)
    const result = chunkMessage(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(text)
  })

  test('input of 2001+ chars splits into multiple chunks each <=2000 chars', () => {
    const text = 'a'.repeat(2001)
    const result = chunkMessage(text)
    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000)
    }
    expect(result.join('')).toBe(text)
  })

  test('splits prefer newline boundaries', () => {
    // 1990 'a' chars + newline + 20 'b' chars = 2011 chars total
    // Should split after the newline (at position 1991) not at 2000
    const part1 = 'a'.repeat(1990)
    const part2 = 'b'.repeat(20)
    const text = part1 + '\n' + part2
    const result = chunkMessage(text)
    expect(result.length).toBe(2)
    expect(result[0]).toBe(part1 + '\n')
    expect(result[1]).toBe(part2)
  })

  test('hard-splits at 2000 if no newline in first 2000 chars', () => {
    // 2500 chars, no newlines
    const text = 'x'.repeat(2500)
    const result = chunkMessage(text)
    expect(result[0].length).toBe(2000)
    expect(result[1].length).toBe(500)
    expect(result.join('')).toBe(text)
  })
})
