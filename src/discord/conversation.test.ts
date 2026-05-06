import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { ConversationManager, resolveContextCap } from './conversation.js'
import type { Message, ContentBlock, Provider } from '../providers/types.js'

describe('ConversationManager', () => {
  test('getHistory on unknown channel returns empty array', () => {
    const mgr = new ConversationManager()
    expect(mgr.getHistory('unknown-channel')).toEqual([])
  })

  test('addUserMessage stores a user role entry', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch1', 'hello')
    const history = mgr.getHistory('ch1')
    expect(history).toHaveLength(1)
    expect(history[0]).toEqual({ role: 'user', content: 'hello' })
  })

  test('addAssistantMessage stores an assistant role entry', () => {
    const mgr = new ConversationManager()
    mgr.addAssistantMessage('ch1', 'hi there')
    const history = mgr.getHistory('ch1')
    expect(history).toHaveLength(1)
    expect(history[0]).toEqual({ role: 'assistant', content: 'hi there' })
  })

  test('getHistory returns messages in insertion order', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch1', 'first')
    mgr.addAssistantMessage('ch1', 'second')
    mgr.addUserMessage('ch1', 'third')
    const history = mgr.getHistory('ch1')
    expect(history).toHaveLength(3)
    expect(history[0].content).toBe('first')
    expect(history[1].content).toBe('second')
    expect(history[2].content).toBe('third')
  })

  test('clear resets a channel history', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch1', 'hello')
    mgr.clear('ch1')
    expect(mgr.getHistory('ch1')).toEqual([])
  })

  test('channels have isolated history', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('chA', 'msg A')
    mgr.addUserMessage('chB', 'msg B')
    expect(mgr.getHistory('chA')).toHaveLength(1)
    expect(mgr.getHistory('chA')[0].content).toBe('msg A')
    expect(mgr.getHistory('chB')).toHaveLength(1)
    expect(mgr.getHistory('chB')[0].content).toBe('msg B')
  })

  test('getHistory returns defensive copies — mutations do not affect stored history', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch1', 'original')
    const copy = mgr.getHistory('ch1')
    copy.push({ role: 'user', content: 'injected' })
    expect(mgr.getHistory('ch1')).toHaveLength(1)
  })

  // Phase 56 (TRUNC-01): Rolling-window truncation tests

  test('defaults to 40 turns when constructed with no args — 100 messages stay at 80', () => {
    const mgr = new ConversationManager()
    for (let i = 0; i < 100; i++) {
      mgr.addUserMessage('ch1', `msg-${i}`)
    }
    expect(mgr.getHistory('ch1').length).toBe(80)
  })

  test('respects custom maxTurns — cap is maxTurns * 2', () => {
    const mgr = new ConversationManager(3)
    // Add 5 user + 5 assistant = 10 messages; cap is 6
    for (let i = 0; i < 5; i++) {
      mgr.addUserMessage('ch1', `user-${i}`)
      mgr.addAssistantMessage('ch1', `assistant-${i}`)
    }
    const history = mgr.getHistory('ch1')
    // Only last 6 messages should remain
    expect(history.length).toBe(6)
    // The oldest 4 messages were evicted; first remaining is user-2
    expect(history[0]).toEqual({ role: 'user', content: 'user-2' })
  })

  test('getHistory returns defensive copy after truncation — mutation does not affect next call', () => {
    const mgr = new ConversationManager(3)
    for (let i = 0; i < 8; i++) {
      mgr.addUserMessage('ch1', `msg-${i}`)
    }
    const first = mgr.getHistory('ch1')
    expect(first.length).toBe(6)
    first.push({ role: 'user', content: 'injected' })
    // Next call should still return 6, not 7
    expect(mgr.getHistory('ch1').length).toBe(6)
  })

  test('invalid maxTurns (0) falls back to default 40 — 100 messages stays at 80', () => {
    const mgr = new ConversationManager(0)
    for (let i = 0; i < 100; i++) {
      mgr.addUserMessage('ch1', `msg-${i}`)
    }
    expect(mgr.getHistory('ch1').length).toBe(80)
  })

  test('invalid maxTurns (-5) falls back to default 40 — 100 messages stays at 80', () => {
    const mgr = new ConversationManager(-5)
    for (let i = 0; i < 100; i++) {
      mgr.addUserMessage('ch1', `msg-${i}`)
    }
    expect(mgr.getHistory('ch1').length).toBe(80)
  })

  test('clear still works post-truncation', () => {
    const mgr = new ConversationManager(3)
    for (let i = 0; i < 10; i++) {
      mgr.addUserMessage('ch1', `msg-${i}`)
    }
    expect(mgr.getHistory('ch1').length).toBe(6)
    mgr.clear('ch1')
    expect(mgr.getHistory('ch1')).toEqual([])
  })

  // Phase 57 (STRIP-01, STRIP-02): getTokenEstimate + stripToolResults tests

  // Test G: empty channel returns 0
  test('getTokenEstimate returns 0 on empty channel', () => {
    const mgr = new ConversationManager()
    expect(mgr.getTokenEstimate('never-used')).toBe(0)
  })

  // Test H: positive integer for channel with text history
  test('getTokenEstimate returns positive integer for channel with text history', () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch-h', 'Hello there, this is a test message')
    mgr.addAssistantMessage('ch-h', 'Sure, I can help with that')
    mgr.addUserMessage('ch-h', 'What is the capital of France?')
    expect(mgr.getTokenEstimate('ch-h')).toBeGreaterThan(0)
  })

  // Test I: ContentBlock arrays counted (tool_use JSON contributes tokens)
  test('getTokenEstimate counts ContentBlock arrays via JSON-stringify path', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-i'
    // Seed with a message that has a tool_use block (non-text, uses JSON.stringify path)
    const seed: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/very/long/path/to/file.ts' } },
        ],
      },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)
    const withTool = mgr.getTokenEstimate(ch)

    // Compare to the same channel with only null content
    const mgr2 = new ConversationManager()
    const seed2: Message[] = [{ role: 'assistant', content: null }]
    ;(mgr2 as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed2)
    const withNull = mgr2.getTokenEstimate(ch)

    // tool_use JSON should contribute tokens; null is skipped → withTool > withNull
    expect(withTool).toBeGreaterThan(withNull)
  })

  // Test J: stripToolResults is no-op when history shorter than keepTailTurns
  test('stripToolResults on channel shorter than keepTailTurns is a no-op', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-j'
    // Only 2 messages, keepTailTurns default is 4
    const seed: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'data' }] },
      { role: 'assistant', content: 'Done' },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)
    const tokensBefore = mgr.getTokenEstimate(ch)
    const result = mgr.stripToolResults(ch)
    expect(result.turnsStripped).toBe(0)
    expect(result.tokensAfter).toBe(result.tokensBefore)
    expect(result.tokensBefore).toBe(tokensBefore)
  })

  // Test K: full rewrite — tool_use dropped from assistant, tool_result → placeholder, tail untouched
  test('stripToolResults rewrites tool_use → nothing and tool_result → placeholder; preserves tail', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-k'
    // 6 messages: 2 round-trips (assistant tool_use → user tool_result → assistant text) × 2
    const seed: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read foo.ts' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'foo.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'file contents...' },
        ],
      },
      { role: 'assistant', content: 'Here is what I found...' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Now reading bar.ts' },
          { type: 'tool_use', id: 't2', name: 'read', input: { path: 'bar.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't2', content: 'more contents' },
        ],
      },
      { role: 'assistant', content: 'Final answer' },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)

    // keepTailTurns=2 → stripUntil=4, candidates are arr[0..3]
    // arr[0]: assistant with tool_use → rewritten (1 stripped)
    // arr[1]: user with tool_result → rewritten (2 stripped)
    // arr[2]: assistant with string content → skipped (no tool blocks)
    // arr[3]: assistant with tool_use → rewritten (3 stripped)
    const result = mgr.stripToolResults(ch, 2)
    expect(result.turnsStripped).toBe(3)
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore)

    const after = mgr.getHistory(ch)

    // arr[0]: tool_use gone, text preserved, compressed: true
    expect(after[0].compressed).toBe(true)
    const a0 = after[0].content as ContentBlock[]
    expect(a0.find(b => b.type === 'tool_use')).toBeUndefined()
    expect(a0.find(b => b.type === 'text' && (b as { text: string }).text === 'I will read foo.ts')).toBeTruthy()

    // arr[1]: tool_result replaced with placeholder, compressed: true
    expect(after[1].compressed).toBe(true)
    const a1 = after[1].content as ContentBlock[]
    expect(a1.find(b => b.type === 'tool_result')).toBeUndefined()
    expect(a1.find(b => b.type === 'text' && (b as { text: string }).text === '[tool_result stripped]')).toBeTruthy()

    // arr[2]: string content, no tool blocks → not rewritten (no compressed flag)
    expect(after[2].compressed).toBeUndefined()

    // arr[3]: tool_use gone, compressed: true
    expect(after[3].compressed).toBe(true)

    // Last 2 messages (tail) must be untouched — no compressed flag
    expect(after[4].compressed).toBeUndefined()
    expect(after[5].compressed).toBeUndefined()
  })

  // Test L: already-compressed messages are skipped (re-compression guard)
  test('stripToolResults skips messages already tagged compressed: true', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-l'
    const originalContent: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.ts' } },
    ]
    const seed: Message[] = [
      { role: 'assistant', content: originalContent, compressed: true },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'data' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'done' },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)

    // keepTailTurns=2 → stripUntil=3, candidates are arr[0..2]
    // arr[0]: already compressed → skipped (not counted in turnsStripped)
    // arr[1]: user tool_result → rewritten (1 stripped)
    // arr[2]: assistant string → no tool blocks → skipped
    const result = mgr.stripToolResults(ch, 2)
    expect(result.turnsStripped).toBe(1)

    const after = mgr.getHistory(ch)
    // arr[0] content unchanged (still has the original tool_use block — was skipped)
    expect(after[0].content).toEqual(originalContent)
  })

  // Test M: tail entries are preserved verbatim including their tool blocks
  test('stripToolResults preserves last keepTailTurns entries verbatim including tool blocks', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-m'
    const tailContent: ContentBlock[] = [
      { type: 'tool_use', id: 't99', name: 'write', input: { path: 'out.ts', content: 'code' } },
    ]
    const seed: Message[] = [
      { role: 'user', content: 'old message 1' },
      { role: 'assistant', content: 'old response 1' },
      { role: 'user', content: 'old message 2' },
      // These are the last 2 (tail) entries:
      { role: 'assistant', content: tailContent },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't99', content: 'written' }] },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)

    // keepTailTurns=2 → last 2 entries (indices 3,4) are preserved
    mgr.stripToolResults(ch, 2)

    const after = mgr.getHistory(ch)
    // Tail entries untouched
    expect(after[3].compressed).toBeUndefined()
    expect(after[3].content).toEqual(tailContent)  // tool_use block still there
    expect(after[4].compressed).toBeUndefined()
  })

  // Test N: default keepTailTurns is 4 when arg is omitted
  test('stripToolResults default keepTailTurns is 4 when arg omitted', () => {
    const mgr = new ConversationManager()
    const ch = 'ch-n'
    // 6 messages: first 2 are strippable, last 4 are tail
    const seed: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'content' },
        ],
      },
      { role: 'assistant', content: 'tail-1' },
      { role: 'user', content: 'tail-2' },
      { role: 'assistant', content: 'tail-3' },
      { role: 'user', content: 'tail-4' },
    ]
    ;(mgr as unknown as { sessions: Map<string, Message[]> }).sessions.set(ch, seed)

    // No second arg → keepTailTurns defaults to 4
    // stripUntil = 6 - 4 = 2, so arr[0..1] are candidates
    const result = mgr.stripToolResults(ch)
    expect(result.turnsStripped).toBe(2)

    const after = mgr.getHistory(ch)
    // First 2 rewritten
    expect(after[0].compressed).toBe(true)
    expect(after[1].compressed).toBe(true)
    // Last 4 untouched
    expect(after[2].compressed).toBeUndefined()
    expect(after[3].compressed).toBeUndefined()
    expect(after[4].compressed).toBeUndefined()
    expect(after[5].compressed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// COST-06 (Phase 61): countTokensWithProvider tests
// ---------------------------------------------------------------------------
describe('ConversationManager.countTokensWithProvider (COST-06, Phase 61)', () => {
  type StubProvider = {
    readonly name: string
    stream: () => Promise<never>
    countTokens?: (msgs: Message[]) => Promise<number>
  }

  function makeProviderWithCount(perMessage: number): StubProvider {
    return {
      name: 'stub-with-count',
      stream: async () => {
        throw new Error('not used')
      },
      countTokens: async (msgs) => msgs.length * perMessage,
    }
  }

  function makeProviderNoCount(): StubProvider {
    return {
      name: 'stub-no-count',
      stream: async () => {
        throw new Error('not used')
      },
    }
  }

  test('uses provider.countTokens when available', async () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch-cost06-1', 'hello')
    mgr.addAssistantMessage('ch-cost06-1', 'hi')
    const provider = makeProviderWithCount(100)
    const count = await mgr.countTokensWithProvider('ch-cost06-1', provider as never)
    expect(count).toBe(200) // 2 messages × 100
  })

  test('falls through to getTokenEstimate when provider lacks countTokens', async () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch-cost06-2', 'sample content for heuristic')
    const provider = makeProviderNoCount()
    const count = await mgr.countTokensWithProvider('ch-cost06-2', provider as never)
    const heuristic = mgr.getTokenEstimate('ch-cost06-2')
    expect(count).toBe(heuristic)
  })

  test('empty channel returns 0 without calling provider.countTokens', async () => {
    const mgr = new ConversationManager()
    let called = false
    const provider: StubProvider = {
      name: 'stub-empty',
      stream: async () => {
        throw new Error('not used')
      },
      countTokens: async () => {
        called = true
        return 999
      },
    }
    const count = await mgr.countTokensWithProvider('unknown-channel', provider as never)
    expect(count).toBe(0)
    expect(called).toBe(false)
  })

  test('provider.countTokens throws → falls through to getTokenEstimate', async () => {
    const mgr = new ConversationManager()
    mgr.addUserMessage('ch-cost06-3', 'content here')
    const provider: StubProvider = {
      name: 'throwing-stub',
      stream: async () => {
        throw new Error('not used')
      },
      countTokens: async () => {
        throw new Error('provider down')
      },
    }
    const count = await mgr.countTokensWithProvider('ch-cost06-3', provider as never)
    const heuristic = mgr.getTokenEstimate('ch-cost06-3')
    expect(count).toBe(heuristic)
  })
})

// ---------------------------------------------------------------------------
// COST-07 (Phase 61): resolveContextCap helper
// ---------------------------------------------------------------------------
describe('resolveContextCap (COST-07)', () => {
  test('glm-4.7-flash → 64_000', () => {
    expect(resolveContextCap('glm-4.7-flash', undefined)).toBe(64_000)
  })

  test('glm-4.6 → 128_000', () => {
    expect(resolveContextCap('glm-4.6', undefined)).toBe(128_000)
  })

  test('claude-sonnet-4-5-20250929 → 160_000', () => {
    expect(resolveContextCap('claude-sonnet-4-5-20250929', undefined)).toBe(160_000)
  })

  test('profile override wins over default', () => {
    expect(resolveContextCap('anything', 42_000)).toBe(42_000)
  })

  test('unknown model → conservative default ≤ 100_000', () => {
    const cap = resolveContextCap('weird-local-model', undefined)
    expect(cap).toBeGreaterThan(0)
    expect(cap).toBeLessThanOrEqual(100_000)
  })

  test('glm-5.1 → 64_000 (Discord profile default)', () => {
    expect(resolveContextCap('glm-5.1', undefined)).toBe(64_000)
  })

  test('glm-4.5-air → 64_000', () => {
    expect(resolveContextCap('glm-4.5-air', undefined)).toBe(64_000)
  })

  test('claude-haiku-4-5 → 80_000', () => {
    expect(resolveContextCap('claude-haiku-4-5', undefined)).toBe(80_000)
  })
})

// ---------------------------------------------------------------------------
// COST-07 (Phase 61): ConversationManager.enforceTokenCap
// ---------------------------------------------------------------------------
describe('ConversationManager.enforceTokenCap (COST-07)', () => {
  // Stub provider with countTokens: per-message fixed count for deterministic assertions.
  function makeStubProvider(perMessage: number): Provider {
    return {
      name: 'stub',
      stream: async () => {
        throw new Error('not used')
      },
      countTokens: async (msgs) => msgs.length * perMessage,
    }
  }

  const restores: Array<ReturnType<typeof spyOn>> = []
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.mockRestore()
  })

  test('Test 1 (no-op path): under-cap channel returns dropped=0 and no warning', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-cap-1'
    mgr.addUserMessage(ch, 'user')
    mgr.addAssistantMessage(ch, 'assistant')
    mgr.addUserMessage(ch, 'user2') // 3 messages × 1000 = 3000

    const provider = makeStubProvider(1000)
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    const result = await mgr.enforceTokenCap(ch, provider, 64_000)
    expect(result.before).toBe(3000)
    expect(result.after).toBe(3000)
    expect(result.dropped).toBe(0)
    // No [context-cap] line
    const capWarnings = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[context-cap]'),
    )
    expect(capWarnings.length).toBe(0)
  })

  test('Test 2 (pair drop): 10 messages × 20k = 200k → cap 64k drops oldest pairs', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-cap-2'
    // 5 user+assistant pairs (10 msgs), stub returns 20k per message → 200k total.
    for (let i = 0; i < 5; i++) {
      mgr.addUserMessage(ch, `user ${i}`)
      mgr.addAssistantMessage(ch, `assistant ${i}`)
    }
    const provider = makeStubProvider(20_000)
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    const result = await mgr.enforceTokenCap(ch, provider, 64_000)
    expect(result.before).toBe(200_000)
    expect(result.after).toBeLessThanOrEqual(64_000)
    expect(result.dropped).toBeGreaterThan(0)
    // Final message count should be even (pairs preserved).
    const remaining = mgr.getHistory(ch)
    expect(remaining.length % 2).toBe(0)
    // First remaining message should be a user message (pair integrity).
    if (remaining.length > 0) expect(remaining[0].role).toBe('user')
  })

  test('Test 3 (warning): truncation fires → one [context-cap] stderr line', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-cap-3'
    for (let i = 0; i < 5; i++) {
      mgr.addUserMessage(ch, `u${i}`)
      mgr.addAssistantMessage(ch, `a${i}`)
    }
    const provider = makeStubProvider(20_000)
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    await mgr.enforceTokenCap(ch, provider, 64_000)
    const capCalls = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[context-cap]'))
    expect(capCalls.length).toBeGreaterThanOrEqual(1)
    // Content checks: channel, before, after, dropped, cap
    expect(capCalls[0]).toContain(ch)
    expect(capCalls[0]).toContain('before=')
    expect(capCalls[0]).toContain('after=')
    expect(capCalls[0]).toContain('dropped=')
    expect(capCalls[0]).toContain('cap=64000')
  })

  test('Test 4 (empty channel): returns all zeros without calling provider', async () => {
    const mgr = new ConversationManager()
    let called = false
    const provider: Provider = {
      name: 'counter',
      stream: async () => {
        throw new Error('not used')
      },
      countTokens: async () => {
        called = true
        return 999
      },
    }
    const result = await mgr.enforceTokenCap('unknown', provider, 64_000)
    expect(result).toEqual({ before: 0, after: 0, dropped: 0 })
    expect(called).toBe(false)
  })

  test('Test 5 (never strips mid-turn): pair-drop preserves alignment', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-cap-5'
    // Build exactly 4 pairs, each message ~40k tokens → 320k total, cap 100k.
    for (let i = 0; i < 4; i++) {
      mgr.addUserMessage(ch, `pair-${i}-user`)
      mgr.addAssistantMessage(ch, `pair-${i}-assistant`)
    }
    const provider = makeStubProvider(40_000)
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    await mgr.enforceTokenCap(ch, provider, 100_000)
    const remaining = mgr.getHistory(ch)
    // Whatever remains, pairs must be preserved — user at even indices, assistant at odd.
    for (let i = 0; i < remaining.length; i += 2) {
      expect(remaining[i].role).toBe('user')
      if (i + 1 < remaining.length) expect(remaining[i + 1].role).toBe('assistant')
    }
  })

  test('Test 6 (custom cap override): explicit cap respected', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-cap-6'
    for (let i = 0; i < 6; i++) {
      mgr.addUserMessage(ch, `u${i}`)
      mgr.addAssistantMessage(ch, `a${i}`)
    }
    const provider = makeStubProvider(5_000) // 12 × 5k = 60k
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    // Cap 42k — should drop pairs until under.
    const result = await mgr.enforceTokenCap(ch, provider, 42_000)
    expect(result.before).toBe(60_000)
    expect(result.after).toBeLessThanOrEqual(42_000)
  })

  test('Test 7 (234k v3.5-MILESTONE fixture): simulates §7 per-turn profile', async () => {
    const mgr = new ConversationManager()
    const ch = 'ch-v35'
    // 7 pairs (14 messages), ~16.7k per msg → ~234k total.
    for (let i = 0; i < 7; i++) {
      mgr.addUserMessage(ch, `user ${i} — discussing langchain zhipuai glm integration`)
      mgr.addAssistantMessage(
        ch,
        `assistant response ${i} with code blocks and detailed analysis`,
      )
    }
    const provider = makeStubProvider(16_700) // 14 × 16.7k ≈ 234k
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    restores.push(stderrSpy)

    const result = await mgr.enforceTokenCap(ch, provider, 64_000)
    expect(result.before).toBeGreaterThan(200_000)
    expect(result.after).toBeLessThanOrEqual(64_000)
    expect(result.dropped).toBeGreaterThanOrEqual(6) // ≥ 3 pairs dropped
  })
})
