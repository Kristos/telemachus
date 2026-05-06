import { describe, it, expect } from 'bun:test'
import { chunkForDiscord, resolveDeployReply } from './deploy-command.js'

describe('chunkForDiscord', () => {
  it('passes through short messages unchanged', () => {
    expect(chunkForDiscord('hello world')).toEqual(['hello world'])
  })

  it('splits long messages on line boundaries', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n')
    const chunks = chunkForDiscord(lines, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500)
    }
  })

  it('reassembles to the original text (minus added newlines)', () => {
    const text = 'a\nb\nc\nd'
    const chunks = chunkForDiscord(text, 4)
    expect(chunks.join('\n')).toBe(text)
  })
})

describe('resolveDeployReply', () => {
  // The resolver is module-level; these tests must not leak state between tests.
  // We rely on the resolver being null at module load since no test arms it.

  it('returns false when no approval is pending', () => {
    expect(resolveDeployReply('yes')).toBe(false)
    expect(resolveDeployReply('no')).toBe(false)
    expect(resolveDeployReply('anything')).toBe(false)
  })
})
