/**
 * RouterProvider unit tests — Phase 59 (ROUTE-01..05, D-01..05, D-12)
 *
 * Test IDs map to 59-VALIDATION.md: 59-02-01 through 59-02-22.
 *
 * Discipline:
 * - spyOn + afterEach restore (NEVER mock.module per CLAUDE.md)
 * - auditSpy wired module-level, restored in afterEach
 */
import { describe, it, expect, spyOn, afterEach, beforeEach, mock } from 'bun:test'
import { RouterProvider } from './router.js'
import * as auditModule from '../security/audit.js'
import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse } from './types.js'
import type { RouterConfig, IntentClass } from '../config/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubProvider(name: string, overrideFn?: Provider['stream']): Provider {
  const defaultStream: Provider['stream'] = async (_messages, _tools, _opts) => ({
    text: '{"decision":"casual"}',
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: null,
  })
  return { name, stream: mock(overrideFn ?? defaultStream) }
}

function makeConfig(overrides?: Partial<RouterConfig>): RouterConfig {
  return {
    classifier: 'openai-compat',
    simple: 'openai-compat',
    complex: 'openai-compat',
    heuristicEnabled: true,
    classifierTokenCap: 600,
    classifierTimeoutMs: 5000,
    ...overrides,
  }
}

function makeOpts(overrides?: Partial<StreamOptions>): StreamOptions {
  return {
    onTextChunk: () => {},
    turnId: 'turn-001',
    maxTokens: 1024,
    ...overrides,
  }
}

const TOOLS: APIToolSchema[] = []

// ---------------------------------------------------------------------------
// Audit spy
// ---------------------------------------------------------------------------

let auditSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  auditSpy = spyOn(auditModule, 'appendAuditEntry').mockResolvedValue(undefined)
})

afterEach(() => {
  auditSpy?.mockRestore()
  auditSpy = null
})

// ---------------------------------------------------------------------------
// describe: class shape (ROUTE-01, D-03) — 59-02-01, 59-02-02, 59-02-21
// ---------------------------------------------------------------------------

describe('RouterProvider — class shape (ROUTE-01, D-03)', () => {
  it('implements Provider', () => {
    const s = makeStubProvider('stub')
    const router = new RouterProvider({
      classifier: s,
      simple: s,
      complex: s,
      config: makeConfig(),
    })
    expect(router.name).toBe('router')
  })

  it('constructor accepts classifier/simple/complex sub-providers', () => {
    const classifier = makeStubProvider('classifier')
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    expect(router).toBeDefined()
    expect(router.name).toBe('router')
  })

  it('missing turnId throws with Discord-only invariant message', async () => {
    const s = makeStubProvider('stub')
    const router = new RouterProvider({
      classifier: s,
      simple: s,
      complex: s,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    await expect(router.stream(msgs, TOOLS, { onTextChunk: () => {} })).rejects.toThrow(
      /Discord-only invariant/,
    )
  })
})

// ---------------------------------------------------------------------------
// describe: decision cache (D-01, D-02) — 59-02-17, 59-02-19, 59-02-20
// ---------------------------------------------------------------------------

describe('RouterProvider — decision cache (D-01, D-02)', () => {
  it('same turnId cache — second call reuses decision, no re-classify', async () => {
    const classifier = makeStubProvider('classifier')
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const opts = makeOpts({ turnId: 'turn-cache-001' })

    // First call — fast-path "hi" (1 word, no keywords)
    await router.stream(msgs, TOOLS, opts)
    // Second call — same turnId
    await router.stream(msgs, TOOLS, opts)

    // Fast-path bypasses classifier; classifier.stream should never be called
    expect(classifier.stream).not.toHaveBeenCalled()
    // simple.stream called twice (dispatched both times)
    expect(simple.stream).toHaveBeenCalledTimes(2)
  })

  it('cache eviction — 129th insertion drops oldest', async () => {
    const s = makeStubProvider('stub')
    const router = new RouterProvider({
      classifier: s,
      simple: s,
      complex: s,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]

    // Drive 129 distinct turnIds — all fast-path
    for (let i = 1; i <= 129; i++) {
      await router.stream(msgs, TOOLS, makeOpts({ turnId: `turn-evict-${String(i).padStart(3, '0')}` }))
    }

    // Now stream with turn-evict-001 again — it was evicted, so a fresh decision is made
    // auditSpy should have been called 130 times total (129 + 1 re-classify for evicted turn)
    await router.stream(msgs, TOOLS, makeOpts({ turnId: 'turn-evict-001' }))

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBe(130)
  })

  it('cache hit no re-emit — second call with same turnId does not emit router_decision twice', async () => {
    const s = makeStubProvider('stub')
    const router = new RouterProvider({
      classifier: s,
      simple: s,
      complex: s,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const opts = makeOpts({ turnId: 'turn-no-re-emit' })

    await router.stream(msgs, TOOLS, opts)
    await router.stream(msgs, TOOLS, opts)

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// describe: fast-path heuristic (ROUTE-02) — 59-02-03, 59-02-04, 59-02-05, 59-02-18
// ---------------------------------------------------------------------------

describe('RouterProvider — fast-path heuristic (ROUTE-02)', () => {
  it('fast-path simple — single word message routes to simple with classifier never called', async () => {
    const classifier = makeStubProvider('classifier')
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const opts = makeOpts({ turnId: 'turn-fp-001' })

    const result = await router.stream(msgs, TOOLS, opts)
    expect(classifier.stream).not.toHaveBeenCalled()
    expect(simple.stream).toHaveBeenCalledTimes(1)
    expect(complex.stream).not.toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('keyword rejects fast-path — "fix this bug" → classifier path', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'fix this bug' }]
    const opts = makeOpts({ turnId: 'turn-keyword-001' })

    await router.stream(msgs, TOOLS, opts)
    expect(classifier.stream).toHaveBeenCalledTimes(1)
    expect(complex.stream).toHaveBeenCalledTimes(1)
  })

  it('code fence rejects fast-path — message with ``` → classifier path', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"simple"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'look at this:\n```js\nconst x = 1\n```' }]
    const opts = makeOpts({ turnId: 'turn-fence-001' })

    await router.stream(msgs, TOOLS, opts)
    expect(classifier.stream).toHaveBeenCalledTimes(1)
  })

  it('fast-path audit — fast-path turn emits router_decision with fastPath: true, classifierTokens: 0', async () => {
    const s = makeStubProvider('stub')
    const router = new RouterProvider({
      classifier: s,
      simple: s,
      complex: s,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'ok' }]
    const opts = makeOpts({ turnId: 'turn-fp-audit-001' })

    await router.stream(msgs, TOOLS, opts)

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBeGreaterThanOrEqual(1)
    const entry = decisionCalls[0][0] as {
      fastPath: boolean
      classifierTokens: number
      decision: string
    }
    expect(entry.fastPath).toBe(true)
    expect(entry.classifierTokens).toBe(0)
    expect(entry.decision).toBe('casual')
  })
})

// ---------------------------------------------------------------------------
// describe: classifier call (ROUTE-03) — 59-02-06, 59-02-07, 59-02-08, 59-02-09
// ---------------------------------------------------------------------------

describe('RouterProvider — classifier call (ROUTE-03)', () => {
  it('classifier happy path — parses JSON, routes per decision, caches by turnId', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'write a function that sorts an array' }]
    const opts = makeOpts({ turnId: 'turn-classifier-001' })

    await router.stream(msgs, TOOLS, opts)
    expect(classifier.stream).toHaveBeenCalledTimes(1)
    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()

    // Second call reuses cached decision
    await router.stream(msgs, TOOLS, opts)
    expect(classifier.stream).toHaveBeenCalledTimes(1) // no re-classify
    expect(complex.stream).toHaveBeenCalledTimes(2)
  })

  it('token cap — classifier input stays within 600 tokens even with long history', async () => {
    let capturedMessages: Message[] | null = null
    const classifier = makeStubProvider('classifier', async (messages) => {
      capturedMessages = messages
      return {
        text: '{"decision":"complex"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ classifierTokenCap: 600 }),
    })

    // Build a history with 10 long user+assistant messages
    const longContent = 'A'.repeat(500) // ~125 tokens each
    const msgs: Message[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: longContent })
      msgs.push({ role: 'assistant', content: longContent })
    }
    // Add the current user message
    msgs.push({ role: 'user', content: 'write a function to parse this' })

    const opts = makeOpts({ turnId: 'turn-cap-001' })
    await router.stream(msgs, TOOLS, opts)

    expect(capturedMessages).not.toBeNull()
    expect(classifier.stream).toHaveBeenCalledTimes(1)

    // The user content in the classifier messages should not exceed 600 + currentMsgTokens
    const { encode } = await import('gpt-tokenizer')
    const userMsg = capturedMessages![1]
    const content = typeof userMsg.content === 'string' ? userMsg.content : ''
    const tokens = encode(content).length
    expect(tokens).toBeLessThanOrEqual(700) // 600 cap + some tolerance for current msg
  })

  it('messages shape — classifier called with system + user role messages', async () => {
    let capturedMessages: Message[] | null = null
    const classifier = makeStubProvider('classifier', async (messages) => {
      capturedMessages = messages
      return {
        text: '{"decision":"casual"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a sorting algorithm' }]
    const opts = makeOpts({ turnId: 'turn-shape-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(capturedMessages).not.toBeNull()
    expect(capturedMessages!.length).toBe(2)
    expect(capturedMessages![0].role).toBe('system')
    expect(capturedMessages![1].role).toBe('user')
    const userContent = capturedMessages![1].content as string
    expect(userContent).toContain('Current message:')
  })

  it('responseFormat — classifier called with json_object responseFormat and maxTokens 50 (Phase 59.1 D-02)', async () => {
    let capturedOpts: StreamOptions | null = null
    const classifier = makeStubProvider('classifier', async (_messages, _tools, opts) => {
      capturedOpts = opts
      return {
        text: '{"decision":"casual"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a feature' }]
    const opts = makeOpts({ turnId: 'turn-rf-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.responseFormat).toEqual({ type: 'json_object' })
    expect(capturedOpts!.maxTokens).toBe(50)
  })

  it('thinking disabled — classifier call passes thinking:{type:disabled} (Phase 59.1-02 FIX-ROUTER-02)', async () => {
    let capturedOpts: StreamOptions | null = null
    const classifier = makeStubProvider('classifier', async (_messages, _tools, opts) => {
      capturedOpts = opts
      return {
        text: '{"decision":"casual"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a feature' }]
    const opts = makeOpts({ turnId: 'turn-thinking-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.thinking).toEqual({ type: 'disabled' })
  })

  it('thinking disabled does not regress responseFormat / maxTokens (Phase 59.1-02 regression guard)', async () => {
    let capturedOpts: StreamOptions | null = null
    const classifier = makeStubProvider('classifier', async (_messages, _tools, opts) => {
      capturedOpts = opts
      return {
        text: '{"decision":"complex"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'debug this stack trace' }]
    const opts = makeOpts({ turnId: 'turn-thinking-regression-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(capturedOpts).not.toBeNull()
    // All three 59.1 classifier options must coexist at the single call site.
    expect(capturedOpts!.responseFormat).toEqual({ type: 'json_object' })
    expect(capturedOpts!.maxTokens).toBe(50)
    expect(capturedOpts!.thinking).toEqual({ type: 'disabled' })
  })
})

// ---------------------------------------------------------------------------
// describe: fail-open (ROUTE-04) — 59-02-10, 59-02-11, 59-02-12, 59-02-13
// ---------------------------------------------------------------------------

describe('RouterProvider — fail-open (ROUTE-04)', () => {
  it('fail open on error — classifier throws → decision=complex, router_escalation emitted', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      throw new Error('classifier connection failed')
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a parser' }]
    const opts = makeOpts({ turnId: 'turn-err-001' })

    await router.stream(msgs, TOOLS, opts)

    // Should route to complex
    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()

    // router_escalation emitted
    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    expect((escalationCalls[0][0] as { reason: string }).reason).toBe('classifier_error')
  })

  it('fail open on timeout — classifier never resolves within configured timeout → complex', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      // Simulate a classifier that takes much longer than the timeout
      await new Promise<never>((resolve) => setTimeout(resolve, 10_000))
      return {
        text: '{"decision":"simple"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ classifierTimeoutMs: 50 }), // very short timeout for test
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a complex feature' }]
    const opts = makeOpts({ turnId: 'turn-timeout-001' })

    const start = Date.now()
    await router.stream(msgs, TOOLS, opts)
    const elapsed = Date.now() - start

    // Should have completed within ~200ms (not waited the full 10s)
    expect(elapsed).toBeLessThan(500)
    // Should route to complex
    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()

    // router_escalation emitted with timeout reason
    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    expect((escalationCalls[0][0] as { reason: string }).reason).toBe('classifier_timeout')
  }, 2000) // 2s test timeout

  it('fail open on malformed — classifier returns non-JSON text → complex, invalid_output', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: 'not json at all',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'debug this issue' }]
    const opts = makeOpts({ turnId: 'turn-malformed-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    expect((escalationCalls[0][0] as { reason: string }).reason).toBe('invalid_output')
  })

  it('invalid decision enum — classifier returns {"decision":"maybe"} → complex, invalid_output', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"maybe"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'refactor this module' }]
    const opts = makeOpts({ turnId: 'turn-invalid-enum-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    expect((escalationCalls[0][0] as { reason: string }).reason).toBe('invalid_output')
  })
})

// ---------------------------------------------------------------------------
// describe: audit (ROUTE-05) — 59-02-14, 59-02-15, 59-02-16
// ---------------------------------------------------------------------------

describe('RouterProvider — audit (ROUTE-05)', () => {
  it('exactly once — non-fast-path turn emits router_decision exactly once', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'build a new feature' }]
    const opts = makeOpts({ turnId: 'turn-exact-001' })

    await router.stream(msgs, TOOLS, opts)

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBe(1)
  })

  it('audit fields — router_decision contains required fields with correct types', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"casual"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a sorting algorithm' }]
    const opts = makeOpts({ turnId: 'turn-fields-001' })

    await router.stream(msgs, TOOLS, opts)

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBe(1)
    const entry = decisionCalls[0][0] as {
      kind: string
      turnId: string
      decision: string
      fastPath: boolean
      classifierTokens: number
      latencyMs: number
      wasCompressed: boolean
    }
    expect(entry.kind).toBe('router_decision')
    expect(entry.turnId).toBe('turn-fields-001')
    expect(entry.decision).toBe('casual')
    expect(entry.fastPath).toBe(false)
    expect(typeof entry.classifierTokens).toBe('number')
    expect(typeof entry.latencyMs).toBe('number')
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0)
    expect(typeof entry.wasCompressed).toBe('boolean')
    expect(entry.wasCompressed).toBe(false)
  })

  it('wasCompressed — true when latest user message has compressed: true', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [
      { role: 'user', content: 'implement a complex system', compressed: true },
    ]
    const opts = makeOpts({ turnId: 'turn-compressed-001' })

    await router.stream(msgs, TOOLS, opts)

    const decisionCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_decision',
    )
    expect(decisionCalls.length).toBe(1)
    expect((decisionCalls[0][0] as { wasCompressed: boolean }).wasCompressed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// describe: routerSession (D-12) — 59-02-22
// ---------------------------------------------------------------------------

describe('RouterProvider — routerSession (D-12)', () => {
  it('routerSession updates — routedTo and classifierTokens populated after stream', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'build a large system' }]
    const routerSession: { routedTo?: IntentClass; classifierTokens?: number } = {}
    const opts = makeOpts({ turnId: 'turn-session-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('orchestration')
    expect(routerSession.classifierTokens).toBe(7) // outputTokens from classifier
  })
})

// ---------------------------------------------------------------------------
// describe: 4-class intent routing (Phase 74, ROUTE-01, ROUTE-03)
// ---------------------------------------------------------------------------
//
// Invariants:
//   - orchestration ALWAYS routes to complex (ROUTE-03) — no override
//   - casual routes to simple (or simple-slot override)
//   - fast-path short messages return 'casual'
//   - fail-open default is 'orchestration'
// ---------------------------------------------------------------------------

describe('RouterProvider — 4-class intent routing (Phase 74, ROUTE-01, ROUTE-03)', () => {
  it('orchestration routes to complex (ROUTE-03 invariant)', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"orchestration"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'plan and implement a multi-step pipeline' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-orch-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('orchestration')
  })

  it('casual routes to simple provider', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"casual"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'what is 2 plus 2' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-casual-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(simple.stream).toHaveBeenCalledTimes(1)
    expect(complex.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('casual')
  })

  it('code routes to complex provider', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"code"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a binary search tree' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-code-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('code')
  })

  it('research routes to complex provider', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"research"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ heuristicEnabled: false }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'explain the CAP theorem in depth' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-research-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(simple.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('research')
  })

  it('fast-path returns casual (not simple)', async () => {
    const classifier = makeStubProvider('classifier')
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hi' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-fp-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(classifier.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('casual')
  })

  it('fail-open returns orchestration (not complex)', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      throw new Error('classifier failed')
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a multi-step feature' }]
    const routerSession: { routedTo?: IntentClass } = {}
    const opts = makeOpts({ turnId: 'turn-4class-failopen-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(complex.stream).toHaveBeenCalledTimes(1)
    expect(routerSession.routedTo).toBe('orchestration')
  })

  it('code slot — codeModel overrides model for code intent', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"code"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const codeSlot = makeStubProvider('qwen2.5-coder-32b')
    const complex = makeStubProvider('glm-4.6')
    const simple = makeStubProvider('glm-4.7-flash')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      code: codeSlot,
      config: makeConfig({ codeModel: 'qwen2.5-coder-32b', complexModel: 'glm-4.6' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'refactor this entire module' }]
    const routerSession: { routedTo?: IntentClass; routedModel?: string } = {}
    const opts = makeOpts({ turnId: 'turn-4class-codeslot-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(codeSlot.stream).toHaveBeenCalledTimes(1)
    expect(complex.stream).not.toHaveBeenCalled()
    expect(routerSession.routedTo).toBe('code')
    expect(routerSession.routedModel).toBe('qwen2.5-coder-32b')
  })

  it('casual slot — casualModel overrides model for casual intent', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"casual"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const casualSlot = makeStubProvider('glm-4.7-flash')
    const simple = makeStubProvider('glm-4.7-flash-base')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      casual: casualSlot,
      config: makeConfig({ casualModel: 'glm-4.7-flash', simpleModel: 'glm-4.7-flash-base' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'thanks for the help' }]
    const routerSession: { routedTo?: IntentClass; routedModel?: string } = {}
    const opts = makeOpts({ turnId: 'turn-4class-casualslot-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(casualSlot.stream).toHaveBeenCalledTimes(1)
    expect(routerSession.routedTo).toBe('casual')
    expect(routerSession.routedModel).toBe('glm-4.7-flash')
  })
})

// ---------------------------------------------------------------------------
// Phase 59.1 (FIX-ROUTER-01..03): Router production fixes
// ---------------------------------------------------------------------------

describe('RouterProvider — Phase 59.1 classifier hardening (FIX-ROUTER-01, FIX-ROUTER-02)', () => {
  it('maxTokens 50 — classifier called with maxTokens: 50 (not 10)', async () => {
    let capturedOpts: StreamOptions | null = null
    const classifier = makeStubProvider('classifier', async (_messages, _tools, opts) => {
      capturedOpts = opts
      return {
        text: '{"decision":"casual"}',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a sorting algorithm' }]
    const opts = makeOpts({ turnId: 'turn-maxtokens-001' })

    await router.stream(msgs, TOOLS, opts)

    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.maxTokens).toBe(50)
  })

  it('classifierRawResponse captured on invalid_output — raw text present in audit entry', async () => {
    const rawText = '```json\n{"decision":"simple"}\n```' // markdown fence — parse fails
    const classifier = makeStubProvider('classifier', async () => ({
      text: rawText,
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 8, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'debug this issue' }]
    const opts = makeOpts({ turnId: 'turn-raw-001' })

    await router.stream(msgs, TOOLS, opts)

    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    const entry = escalationCalls[0][0] as { reason: string; classifierRawResponse?: string }
    expect(entry.reason).toBe('invalid_output')
    expect(entry.classifierRawResponse).toBe(rawText)
  })

  it('classifierRawResponse truncated to 500 chars with ellipsis when longer', async () => {
    const rawText = 'x'.repeat(600) // 600 chars of noise
    const classifier = makeStubProvider('classifier', async () => ({
      text: rawText,
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement something complex' }]
    const opts = makeOpts({ turnId: 'turn-trunc-001' })

    await router.stream(msgs, TOOLS, opts)

    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    const entry = escalationCalls[0][0] as { reason: string; classifierRawResponse?: string }
    expect(entry.reason).toBe('invalid_output')
    // 500 chars + ellipsis character = 501 code units for '…' (one character)
    expect(entry.classifierRawResponse).toBeDefined()
    expect(entry.classifierRawResponse!.length).toBe(501)
    expect(entry.classifierRawResponse!.endsWith('…')).toBe(true)
    expect(entry.classifierRawResponse!.slice(0, 500)).toBe('x'.repeat(500))
  })

  it('classifierRawResponse absent on classifier_error', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      throw new Error('connection refused')
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(),
    })
    const msgs: Message[] = [{ role: 'user', content: 'refactor this module' }]
    const opts = makeOpts({ turnId: 'turn-err-raw-001' })

    await router.stream(msgs, TOOLS, opts)

    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    const entry = escalationCalls[0][0] as { reason: string; classifierRawResponse?: string }
    expect(entry.reason).toBe('classifier_error')
    expect(entry.classifierRawResponse).toBeUndefined()
  })

  it('classifierRawResponse absent on classifier_timeout', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      await new Promise<never>((resolve) => setTimeout(resolve, 10_000))
      return {
        text: 'never',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: null,
      }
    })
    const simple = makeStubProvider('simple')
    const complex = makeStubProvider('complex')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ classifierTimeoutMs: 30 }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement something complex' }]
    const opts = makeOpts({ turnId: 'turn-timeout-raw-001' })

    await router.stream(msgs, TOOLS, opts)

    const escalationCalls = (auditSpy?.mock.calls ?? []).filter(
      (c: unknown[]) => (c[0] as { kind: string }).kind === 'router_escalation',
    )
    expect(escalationCalls.length).toBe(1)
    const entry = escalationCalls[0][0] as { reason: string; classifierRawResponse?: string }
    expect(entry.reason).toBe('classifier_timeout')
    expect(entry.classifierRawResponse).toBeUndefined()
  }, 2000)
})

describe('RouterProvider — Phase 59.1 routedModel (FIX-ROUTER-03, D-04, D-05, D-06)', () => {
  it('fast-path writes routedModel = simpleModel override', async () => {
    const simple = makeStubProvider('glm-4.7-flash')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier: makeStubProvider('classifier'),
      simple,
      complex,
      config: makeConfig({ simpleModel: 'glm-4.7-flash', complexModel: 'glm-4.6' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'hey' }]
    const routerSession: {
      routedTo?: IntentClass
      routedModel?: string
      classifierTokens?: number
    } = {}
    const opts = makeOpts({ turnId: 'turn-rm-fp-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('casual')
    expect(routerSession.routedModel).toBe('glm-4.7-flash')
  })

  it('classifier-routed casual writes routedModel = simpleModel override', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"casual"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('glm-4.7-flash')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ simpleModel: 'glm-4.7-flash', complexModel: 'glm-4.6' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a quick thing' }]
    const routerSession: {
      routedTo?: IntentClass
      routedModel?: string
      classifierTokens?: number
    } = {}
    const opts = makeOpts({ turnId: 'turn-rm-ccasual-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('casual')
    expect(routerSession.routedModel).toBe('glm-4.7-flash')
  })

  it('classifier-routed complex writes routedModel = complexModel override', async () => {
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"complex"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('glm-4.7-flash')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ simpleModel: 'glm-4.7-flash', complexModel: 'glm-4.6' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'build a distributed scheduler' }]
    const routerSession: {
      routedTo?: IntentClass
      routedModel?: string
      classifierTokens?: number
    } = {}
    const opts = makeOpts({ turnId: 'turn-rm-ccomplex-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('orchestration')
    expect(routerSession.routedModel).toBe('glm-4.6')
  })

  it('fail-open complex writes routedModel = complexModel override', async () => {
    const classifier = makeStubProvider('classifier', async () => {
      throw new Error('classifier failed')
    })
    const simple = makeStubProvider('glm-4.7-flash')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig({ simpleModel: 'glm-4.7-flash', complexModel: 'glm-4.6' }),
    })
    const msgs: Message[] = [{ role: 'user', content: 'implement a parser' }]
    const routerSession: {
      routedTo?: IntentClass
      routedModel?: string
      classifierTokens?: number
    } = {}
    const opts = makeOpts({ turnId: 'turn-rm-failopen-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('orchestration')
    expect(routerSession.routedModel).toBe('glm-4.6')
  })

  it('routedModel falls back to sub-provider name when override absent', async () => {
    // No simpleModel / complexModel in config — falls back to sub-provider.name
    const classifier = makeStubProvider('classifier', async () => ({
      text: '{"decision":"casual"}',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
    }))
    const simple = makeStubProvider('glm-4.7-flash')
    const complex = makeStubProvider('glm-4.6')
    const router = new RouterProvider({
      classifier,
      simple,
      complex,
      config: makeConfig(), // no simpleModel/complexModel
    })
    const msgs: Message[] = [{ role: 'user', content: 'write a short function for me' }]
    const routerSession: {
      routedTo?: IntentClass
      routedModel?: string
      classifierTokens?: number
    } = {}
    const opts = makeOpts({ turnId: 'turn-rm-fallback-001', routerSession })

    await router.stream(msgs, TOOLS, opts)

    expect(routerSession.routedTo).toBe('casual')
    expect(routerSession.routedModel).toBe('glm-4.7-flash') // sub-provider name
  })
})

// ---------------------------------------------------------------------------
// describe: classifierTimeoutMs default regression (COST-03, Phase 61)
// ---------------------------------------------------------------------------
//
// v3.5-MILESTONE-REPORT §7 measured 2/5 classifier calls (40%) timing out at
// 2010ms against Z.ai rate-limited tier, each escalation paying ~$0.19 to
// glm-4.6. Phase 59.1-02 (commit a6c64cb) lowered the default 5000→2000 ms;
// this suite locks that value so a future contributor cannot silently raise
// it back to 5s and re-open the same cost-spike surface.
//
// Tolerance band: timing-based tests absorb CI jitter at ±400ms. Anything
// outside 1800-2400 ms signals the default has drifted. If CI flakes on this,
// the alternative is a Zod schema default — deliberately not added here to
// keep scope tight (flag for 999.x if the band proves insufficient in CI).
// ---------------------------------------------------------------------------

describe('RouterConfig.classifierTimeoutMs (COST-03 regression, Phase 61)', () => {
  it('default is exactly 2000ms when config omits the field', async () => {
    // Hanging classifier: never resolves, forcing the timeout race to win.
    const hangingClassifier: Provider = {
      name: 'hanging',
      stream: () => new Promise<StreamResponse>(() => {}),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    // Config with classifierTimeoutMs omitted — should fall back to default 2000ms.
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false, // disable fast-path so classifier is always invoked
      classifierTokenCap: 600,
    }
    const router = new RouterProvider({ classifier: hangingClassifier, simple, complex, config: cfg })
    const msgs: Message[] = [
      { role: 'user', content: 'please implement a multi-step feature with several moving parts' },
    ]

    const start = Date.now()
    await router.stream(msgs, TOOLS, makeOpts({ turnId: 'cost-03-default-001' }))
    const elapsed = Date.now() - start

    // Band 1800-2400ms absorbs ±400ms CI jitter around the 2000ms target.
    expect(elapsed).toBeGreaterThanOrEqual(1800)
    expect(elapsed).toBeLessThanOrEqual(2400)
  })

  it('explicit classifierTimeoutMs: 500 overrides default', async () => {
    const hangingClassifier: Provider = {
      name: 'hanging',
      stream: () => new Promise<StreamResponse>(() => {}),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierTokenCap: 600,
      classifierTimeoutMs: 500,
    }
    const router = new RouterProvider({ classifier: hangingClassifier, simple, complex, config: cfg })
    const msgs: Message[] = [
      { role: 'user', content: 'please implement a multi-step feature with several moving parts' },
    ]

    const start = Date.now()
    await router.stream(msgs, TOOLS, makeOpts({ turnId: 'cost-03-override-001' }))
    const elapsed = Date.now() - start

    // Tight band — explicit override should fire near 500ms, not near 2000ms.
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThanOrEqual(900)
  })
})

// ---------------------------------------------------------------------------
// describe: RouterClassifierBreaker integration (COST-05, Phase 61)
// ---------------------------------------------------------------------------
//
// The state machine itself is tested in router-classifier-breaker.test.ts.
// These integration tests verify the RouterProvider wiring: the breaker is
// consulted before classifier.stream; escalations record against the breaker;
// transitions emit a router_classifier_paused audit event.
// ---------------------------------------------------------------------------

describe('RouterProvider breaker integration (COST-05, Phase 61)', () => {
  it('Test A: after 3 consecutive escalations, 4th classify short-circuits (skip classifier)', async () => {
    // Classifier that always throws — each stream call records an escalation.
    const throwingClassifier: Provider = {
      name: 'throwing-classifier',
      stream: mock(async () => {
        throw new Error('classifier failed')
      }),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierBreaker: { failureThreshold: 3 }, // trip after 3 escalations
    }
    const router = new RouterProvider({ classifier: throwingClassifier, simple, complex, config: cfg })
    const mkMsgs = (n: number): Message[] => [
      { role: 'user', content: `please implement feature ${n} with multiple steps` },
    ]

    // Turns 1-3: each escalates and records on the breaker.
    await router.stream(mkMsgs(1), TOOLS, makeOpts({ turnId: 'breaker-A-1' }))
    await router.stream(mkMsgs(2), TOOLS, makeOpts({ turnId: 'breaker-A-2' }))
    await router.stream(mkMsgs(3), TOOLS, makeOpts({ turnId: 'breaker-A-3' }))

    // At this point breaker is open. Classifier called 3 times.
    const classifierCallsAfter3 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    expect(classifierCallsAfter3).toBe(3)

    // Turn 4: classify should short-circuit — classifier.stream NOT called.
    await router.stream(mkMsgs(4), TOOLS, makeOpts({ turnId: 'breaker-A-4' }))
    const classifierCallsAfter4 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    expect(classifierCallsAfter4).toBe(3) // still 3 — skipped
  })

  it('Test B: opening the breaker emits router_classifier_paused audit entry', async () => {
    const throwingClassifier: Provider = {
      name: 'throwing-classifier',
      stream: async () => {
        throw new Error('classifier failed')
      },
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierBreaker: { failureThreshold: 1 }, // trip on first escalation
    }
    const router = new RouterProvider({ classifier: throwingClassifier, simple, complex, config: cfg })
    const msgs: Message[] = [{ role: 'user', content: 'please implement a complex multi-step feature' }]

    await router.stream(msgs, TOOLS, makeOpts({ turnId: 'breaker-B-1' }))

    // Find the router_classifier_paused entry
    const pausedCalls = (auditSpy!.mock.calls as unknown[][])
      .map((args) => args[0] as { kind?: string; classifierPauseReason?: string; consecutiveEscalations?: number; classifierName?: string })
      .filter((e) => e.kind === 'router_classifier_paused')
    expect(pausedCalls.length).toBeGreaterThanOrEqual(1)
    const paused = pausedCalls[0]
    expect(paused.classifierPauseReason).toBe('escalation_threshold')
    expect(paused.consecutiveEscalations).toBeGreaterThanOrEqual(1)
    expect(paused.classifierName).toBe('throwing-classifier')
  })

  it('Test D: breaker state is PER-INSTANCE — second RouterProvider has fresh counters', async () => {
    const throwingClassifier: Provider = {
      name: 'throwing-cls',
      stream: mock(async () => {
        throw new Error('classifier failed')
      }),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierBreaker: { failureThreshold: 1 },
    }

    // Trip first instance.
    const router1 = new RouterProvider({ classifier: throwingClassifier, simple, complex, config: cfg })
    await router1.stream(
      [{ role: 'user', content: 'implement a multi-step feature for me' }],
      TOOLS,
      makeOpts({ turnId: 'inst-1-turn-1' }),
    )

    // Second instance should NOT be pre-open — it has fresh breaker state.
    const router2 = new RouterProvider({ classifier: throwingClassifier, simple, complex, config: cfg })
    const callsBefore2 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    await router2.stream(
      [{ role: 'user', content: 'implement something new with many steps' }],
      TOOLS,
      makeOpts({ turnId: 'inst-2-turn-1' }),
    )
    const callsAfter2 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length

    // Instance 2 should have invoked classifier.stream (classifier call went through,
    // then escalated because it throws, but the initial call proves fresh state).
    expect(callsAfter2).toBe(callsBefore2 + 1)
  })

  it('Test E: routerConfig.classifierBreaker override — failureThreshold=1 trips on first escalation', async () => {
    const throwingClassifier: Provider = {
      name: 'throwing-cls',
      stream: mock(async () => {
        throw new Error('classifier failed')
      }),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierBreaker: { failureThreshold: 1 },
    }
    const router = new RouterProvider({ classifier: throwingClassifier, simple, complex, config: cfg })
    const mkMsgs = (n: number): Message[] => [
      { role: 'user', content: `implement a new multi-step feature ${n}` },
    ]

    // Turn 1: classifier called, throws, breaker trips open (threshold=1).
    await router.stream(mkMsgs(1), TOOLS, makeOpts({ turnId: 'override-1' }))
    const callsAfter1 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    expect(callsAfter1).toBe(1)

    // Turn 2: breaker open, classifier should NOT be called.
    await router.stream(mkMsgs(2), TOOLS, makeOpts({ turnId: 'override-2' }))
    const callsAfter2 = (throwingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    expect(callsAfter2).toBe(1) // unchanged
  })

  it('Test F: successful classification closes breaker (self-heal)', async () => {
    let shouldFail = true
    const togglingClassifier: Provider = {
      name: 'toggling-cls',
      stream: mock(async () => {
        if (shouldFail) throw new Error('classifier failed')
        return {
          text: '{"decision":"casual"}',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
          stopReason: null,
        }
      }),
    }
    const simple = makeStubProvider('simple-stub')
    const complex = makeStubProvider('complex-stub')
    const cfg: RouterConfig = {
      classifier: 'openai-compat',
      simple: 'openai-compat',
      complex: 'openai-compat',
      heuristicEnabled: false,
      classifierBreaker: { failureThreshold: 5 }, // leave room for partial failures without opening
    }
    const router = new RouterProvider({ classifier: togglingClassifier, simple, complex, config: cfg })
    const mkMsgs = (n: number): Message[] => [
      { role: 'user', content: `implement a new multi-step feature ${n}` },
    ]

    // 2 failures — not enough to open.
    await router.stream(mkMsgs(1), TOOLS, makeOpts({ turnId: 'heal-1' }))
    await router.stream(mkMsgs(2), TOOLS, makeOpts({ turnId: 'heal-2' }))

    // Toggle to success, classifier now returns {decision:simple}.
    shouldFail = false
    await router.stream(mkMsgs(3), TOOLS, makeOpts({ turnId: 'heal-3' }))

    // 2 more failures — since self-heal cleared counters, we need 5 more to open.
    shouldFail = true
    await router.stream(mkMsgs(4), TOOLS, makeOpts({ turnId: 'heal-4' }))
    await router.stream(mkMsgs(5), TOOLS, makeOpts({ turnId: 'heal-5' }))
    // Breaker should still be closed (only 2 consecutive escalations after reset).
    const callsAfter5 = (togglingClassifier.stream as ReturnType<typeof mock>).mock.calls.length
    expect(callsAfter5).toBe(5) // classifier called every turn
  })
})
