import { describe, test, expect } from 'bun:test'
import { resolvePersona, assembleSystemPrompt, DEFAULT_PERSONA } from './persona'

describe('resolvePersona', () => {
  test('1: returns configured persona for known channel', () => {
    const config = { personas: { 'ch-1': 'auction hype' } }
    expect(resolvePersona('ch-1', config)).toBe('auction hype')
  })

  test('2: returns DEFAULT_PERSONA when config is undefined', () => {
    expect(resolvePersona('ch-1', undefined)).toBe(DEFAULT_PERSONA)
  })

  test('3: returns DEFAULT_PERSONA when personas map is undefined', () => {
    expect(resolvePersona('ch-1', {})).toBe(DEFAULT_PERSONA)
  })

  test('4: returns DEFAULT_PERSONA when channel has no entry', () => {
    const config = { personas: { 'other-channel': 'some persona' } }
    expect(resolvePersona('ch-1', config)).toBe(DEFAULT_PERSONA)
  })

  test('5: returns DEFAULT_PERSONA when channel entry is empty string', () => {
    const config = { personas: { 'ch-1': '' } }
    expect(resolvePersona('ch-1', config)).toBe(DEFAULT_PERSONA)
  })
})

describe('assembleSystemPrompt', () => {
  test('6: concatenates base + persona with \\n\\n separator', () => {
    const config = { personas: { 'ch-1': 'Custom persona.' } }
    const out = assembleSystemPrompt('ch-1', 'BASE', config)
    expect(out).toBe('BASE\n\nCustom persona.')
  })

  test('7: uses DEFAULT_PERSONA for unconfigured channel', () => {
    const out = assembleSystemPrompt('ch-1', 'BASE', { personas: {} })
    expect(out).toBe(`BASE\n\n${DEFAULT_PERSONA}`)
  })

  test('8: drops separator when basePrompt is empty', () => {
    const out = assembleSystemPrompt('ch-1', '', { personas: { 'ch-1': 'Only persona.' } })
    expect(out).toBe('Only persona.')
  })
})

describe('assembleSystemPrompt — suppressEmoji (PERS-02)', () => {
  test('9: appends emoji suppression line when suppressEmoji[channelId] === true', () => {
    const out = assembleSystemPrompt('ch-1', 'BASE', {
      personas: { 'ch-1': 'Custom persona.' },
      suppressEmoji: { 'ch-1': true },
    })
    expect(out).toBe('BASE\n\nCustom persona.\n\nReply in plain text; no emoji.')
  })

  test('10: does NOT append line when suppressEmoji[channelId] === false', () => {
    const out = assembleSystemPrompt('ch-1', 'BASE', {
      personas: { 'ch-1': 'Custom persona.' },
      suppressEmoji: { 'ch-1': false },
    })
    expect(out).toBe('BASE\n\nCustom persona.')
  })

  test('11: does NOT append line when suppressEmoji map is absent', () => {
    const out = assembleSystemPrompt('ch-1', 'BASE', {
      personas: { 'ch-1': 'Custom persona.' },
    })
    expect(out).toBe('BASE\n\nCustom persona.')
  })

  test('12: combines default persona + emoji suppression when no custom persona is configured', () => {
    const out = assembleSystemPrompt('ch-1', 'BASE', {
      suppressEmoji: { 'ch-1': true },
    })
    expect(out).toBe(`BASE\n\n${DEFAULT_PERSONA}\n\nReply in plain text; no emoji.`)
  })
})
