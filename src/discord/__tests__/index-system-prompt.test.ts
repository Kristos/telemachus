/**
 * Phase 64 (PERS-01, PERS-03) — integration test for the per-channel
 * system prompt builder composed in src/discord/index.ts.
 *
 * The builder is pure (base prompt + channelId → per-channel system prompt).
 * No Discord client is spun up — we exercise the composition directly.
 */

import { describe, test, expect } from 'bun:test'
import { assembleSystemPrompt, DEFAULT_PERSONA } from '../persona'

describe('index.ts per-channel system prompt builder', () => {
  test('1: configured channel gets its persona', () => {
    const base = 'BASE'
    const discordConfig = { personas: { 'ch-1': 'auction hype' } }
    const builder = (cid: string) => assembleSystemPrompt(cid, base, discordConfig)
    expect(builder('ch-1')).toBe('BASE\n\nauction hype')
  })

  test('2: unconfigured channel gets DEFAULT_PERSONA', () => {
    const base = 'BASE'
    const discordConfig = { personas: {} }
    const builder = (cid: string) => assembleSystemPrompt(cid, base, discordConfig)
    expect(builder('ch-unknown')).toBe(`BASE\n\n${DEFAULT_PERSONA}`)
  })

  test('3: persona separator is exactly \\n\\n', () => {
    const out = assembleSystemPrompt('c', 'X', { personas: { c: 'Y' } })
    expect(out).toBe('X\n\nY')
  })

  // Phase 64 (PERS-02 programmatic override for live 3-channel checkpoint):
  // Simulates the 3-channel Discord test from 64-05-PLAN.md Task 2 entirely
  // via fixtures. Live verification deferred to user's offline testing.
  test('4: 3-channel simulation — A configured persona, B suppressEmoji, C default', () => {
    const base = 'You are a helpful assistant accessible via Discord.'
    const discordConfig = {
      personas: {
        'CHANNEL-A': 'You are an auction hype assistant. Use energetic tone with occasional exclamation points.',
      },
      suppressEmoji: {
        'CHANNEL-B': true,
      },
    }
    const builder = (cid: string) => assembleSystemPrompt(cid, base, discordConfig)

    // Channel A: configured persona, no emoji suppression
    const outA = builder('CHANNEL-A')
    expect(outA).toContain('You are an auction hype assistant.')
    expect(outA).not.toContain('Reply in plain text; no emoji.')

    // Channel B: no custom persona → DEFAULT_PERSONA + emoji suppression line
    const outB = builder('CHANNEL-B')
    expect(outB).toContain(DEFAULT_PERSONA)
    expect(outB).toContain('Reply in plain text; no emoji.')
    // Verify ordering: base, then persona, then emoji line
    expect(outB).toBe(`${base}\n\n${DEFAULT_PERSONA}\n\nReply in plain text; no emoji.`)

    // Channel C: neither configured → DEFAULT_PERSONA only
    const outC = builder('CHANNEL-C')
    expect(outC).toBe(`${base}\n\n${DEFAULT_PERSONA}`)
    expect(outC).not.toContain('Reply in plain text; no emoji.')
    expect(outC).not.toContain('auction hype')
  })
})
