import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from 'bun:test'
import { FallbackProvider, computeDelay } from './fallback.js'
import { resetAll as resetCircuits } from './circuit-breaker.js'
import * as audit from '../security/audit.js'
import type { Provider, StreamResponse, StreamOptions, Message, APIToolSchema } from './types.js'

function makeProvider(name: string, streamFn: Provider['stream']): Provider {
  return { name, stream: streamFn }
}

const OK_RESPONSE: StreamResponse = {
  text: 'hello',
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: 'end_turn',
}

const MSGS: Message[] = [{ role: 'user', content: 'hi' }]
const TOOLS: APIToolSchema[] = []
const OPTS: StreamOptions = { onTextChunk: () => {} }

// No-op sleep for tests (avoids real delays)
const noopSleep = (_ms: number) => Promise.resolve()

describe('FallbackProvider - backoff and retry', () => {
  beforeEach(() => {
    // Reset circuit-breaker state so tests don't pollute each other.
    resetCircuits()
  })

  afterEach(() => {
    // Restore any spies
  })

  it('returns primary result when primary succeeds (no fallback, no audit)', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primary = makeProvider('primary', mock(async () => OK_RESPONSE))
    const fallback = makeProvider('fallback', mock(async () => { throw new Error('should not be called') }))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    const result = await provider.stream(MSGS, TOOLS, OPTS)
    expect(result.text).toBe('hello')
    expect(primary.stream).toHaveBeenCalledTimes(1)
    expect(fallback.stream).not.toHaveBeenCalled()
    expect(appendSpy).not.toHaveBeenCalled()
    appendSpy.mockRestore()
  })

  it('primary fails once with 429, retries, succeeds on second attempt → no fallback, no audit', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    let callCount = 0
    const primary = makeProvider('primary', mock(async () => {
      callCount++
      if (callCount === 1) throw new Error('429 Too Many Requests')
      return OK_RESPONSE
    }))
    const fallback = makeProvider('fallback', mock(async () => { throw new Error('should not be called') }))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    const result = await provider.stream(MSGS, TOOLS, OPTS)
    expect(result.text).toBe('hello')
    expect(callCount).toBe(2)
    expect(fallback.stream).not.toHaveBeenCalled()
    expect(appendSpy).not.toHaveBeenCalled()
    appendSpy.mockRestore()
  })

  it('primary fails 3 times with 429 → falls back, audit entry written with correct fields', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primary = makeProvider('primary', mock(async () => { throw new Error('429 Too Many Requests') }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    const result = await provider.stream(MSGS, TOOLS, OPTS)
    expect(result.text).toBe('hello')
    expect(fallback.stream).toHaveBeenCalledTimes(1)
    expect(appendSpy).toHaveBeenCalledTimes(1)

    const entry = appendSpy.mock.calls[0][0]
    expect(entry.kind).toBe('provider_switch')
    expect(entry.primaryProvider).toBe('primary')
    expect(entry.fallbackProvider).toBe('fallback')
    expect(entry.triggerCode).toBe(429)
    expect(entry.retryAttempts).toBe(2) // 2 retries before giving up
    appendSpy.mockRestore()
  })

  it('primary fails with 429 + retry-after: 5 → delay is 5000ms (not computed backoff)', async () => {
    const sleepMock = mock(async (_ms: number) => {})
    const primary = makeProvider('primary', mock(async () => {
      throw new Error('429 Too Many Requests retry-after: 5')
    }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: sleepMock })

    await provider.stream(MSGS, TOOLS, OPTS)
    // First delay should use retry-after value: 5000ms
    expect(sleepMock).toHaveBeenCalledTimes(2) // 2 retries
    expect(sleepMock.mock.calls[0][0]).toBe(5000)
  })

  it('primary fails with non-retriable error (400) → throws immediately, no retry, no fallback', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    let callCount = 0
    const primary = makeProvider('primary', mock(async () => {
      callCount++
      throw new Error('400 Bad Request')
    }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    await expect(provider.stream(MSGS, TOOLS, OPTS)).rejects.toThrow('400 Bad Request')
    expect(callCount).toBe(1) // No retries
    expect(fallback.stream).not.toHaveBeenCalled()
    expect(appendSpy).not.toHaveBeenCalled()
    appendSpy.mockRestore()
  })

  it('primary fails with 529 → triggers retry loop same as 429', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    let callCount = 0
    const primary = makeProvider('primary', mock(async () => {
      callCount++
      throw new Error('529 Overloaded')
    }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    const result = await provider.stream(MSGS, TOOLS, OPTS)
    expect(result.text).toBe('hello')
    expect(callCount).toBe(3) // 1 initial + 2 retries
    expect(appendSpy).toHaveBeenCalledTimes(1)
    const entry = appendSpy.mock.calls[0][0]
    expect(entry.triggerCode).toBe(529)
    appendSpy.mockRestore()
  })

  it('audit entry has primaryProvider, fallbackProvider, triggerCode, retryAttempts fields', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primary = makeProvider('cloud-gpt', mock(async () => { throw new Error('503 Service Unavailable') }))
    const fallback = makeProvider('local-llama', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    await provider.stream(MSGS, TOOLS, OPTS)
    expect(appendSpy).toHaveBeenCalledTimes(1)
    const entry = appendSpy.mock.calls[0][0]
    expect(entry.kind).toBe('provider_switch')
    expect(entry.primaryProvider).toBe('cloud-gpt')
    expect(entry.fallbackProvider).toBe('local-llama')
    expect(entry.triggerCode).toBe(503)
    expect(entry.retryAttempts).toBe(2)
    expect(entry.sessionId).toBeDefined()
    expect(entry.platform).toBeDefined()
    appendSpy.mockRestore()
  })

  it('falls back on ECONNREFUSED (network error) with audit', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primary = makeProvider('primary', mock(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8080') }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    const result = await provider.stream(MSGS, TOOLS, OPTS)
    expect(result.text).toBe('hello')
    expect(fallback.stream).toHaveBeenCalledTimes(1)
    // Network errors also write audit
    expect(appendSpy).toHaveBeenCalledTimes(1)
    appendSpy.mockRestore()
  })

  it('throws fallback error when both fail', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primary = makeProvider('primary', mock(async () => { throw new Error('429 rate limited') }))
    const fallback = makeProvider('fallback', mock(async () => { throw new Error('ECONNREFUSED fallback also down') }))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    await expect(provider.stream(MSGS, TOOLS, OPTS)).rejects.toThrow('ECONNREFUSED fallback also down')
    appendSpy.mockRestore()
  })

  it('name combines both provider names', () => {
    const primary = makeProvider('cloud', mock(async () => OK_RESPONSE))
    const fallback = makeProvider('local', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback)

    expect(provider.name).toBe('cloud→local')
  })

  it('onFallbackActive callback is invoked on fallback switch and reset', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const activeCalls: boolean[] = []
    const primary = makeProvider('primary', mock(async () => { throw new Error('429 Too Many Requests') }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      onFallbackActive: (active) => { activeCalls.push(active) },
    })

    await provider.stream(MSGS, TOOLS, OPTS)
    expect(activeCalls).toContain(true)
    appendSpy.mockRestore()
  })

  it('does NOT fall back on non-retriable errors (no retry-after parsing attempted)', async () => {
    const primary = makeProvider('primary', mock(async () => { throw new Error('Invalid prompt format') }))
    const fallback = makeProvider('fallback', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, { sleepFn: noopSleep })

    await expect(provider.stream(MSGS, TOOLS, OPTS)).rejects.toThrow('Invalid prompt format')
    expect(fallback.stream).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Circuit-breaker integration — the 2026-04-14 incident scenario and friends.
//
// These tests use small thresholds/cooldowns via the circuitBreaker option so
// we can exercise the state machine in milliseconds instead of seconds.
// ────────────────────────────────────────────────────────────────────────────

describe('FallbackProvider - circuit breaker', () => {
  beforeEach(() => {
    resetCircuits()
  })

  it('opens primary circuit after N consecutive exhausted-retry requests', async () => {
    const appendSpy = spyOn(audit, 'appendAuditEntry').mockResolvedValue(undefined)
    const primaryFn = mock(async () => { throw new Error('429 rate limited') })
    const primary = makeProvider('cb-primary-1', primaryFn)
    const fallback = makeProvider('cb-fallback-1', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
    })

    // Request #1: retries exhausted → recordFailure (counter = 1, still closed)
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(3)   // 1 initial + 2 retries

    // Request #2: retries exhausted → recordFailure (counter = 2, circuit opens)
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(6)

    // Request #3: circuit OPEN → primary is NOT called, skip straight to fallback
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(6)   // unchanged!
    expect(fallback.stream).toHaveBeenCalledTimes(3)

    // Verify a circuit_state_change audit was emitted for the open transition.
    const transitions = appendSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.kind === 'circuit_state_change')
    expect(transitions.length).toBeGreaterThanOrEqual(1)
    expect(transitions[0].circuitProvider).toBe('cb-primary-1')
    expect(transitions[0].circuitToState).toBe('open')
    expect(transitions[0].circuitReason).toBe('threshold_reached')

    appendSpy.mockRestore()
  })

  it('5-concurrent-subagent scenario: once circuit opens, laggards skip primary', async () => {
    // The 2026-04-14 incident reduced: five parallel callers, primary dead.
    // Without the breaker all five independently retry and time out. With the
    // breaker, subsequent arrivals hit the OPEN circuit and skip straight to
    // fallback, saving wall-clock + tokens.
    const primaryFn = mock(async () => { throw new Error('ECONNREFUSED') })
    const primary = makeProvider('cb-primary-2', primaryFn)
    const fallback = makeProvider('cb-fallback-2', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 5_000 },
    })

    // First two requests exhaust retries and open the circuit.
    await provider.stream(MSGS, TOOLS, OPTS)
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(6) // 2 req × 3 attempts

    // Next three concurrent requests all hit the OPEN circuit simultaneously.
    await Promise.all([
      provider.stream(MSGS, TOOLS, OPTS),
      provider.stream(MSGS, TOOLS, OPTS),
      provider.stream(MSGS, TOOLS, OPTS),
    ])

    // CRITICAL: primary was NOT hit even once more. All three bypassed it.
    expect(primaryFn).toHaveBeenCalledTimes(6)
    expect(fallback.stream).toHaveBeenCalledTimes(5) // requests 1,2 (post-retry) + 3,4,5 (skipped primary)
  })

  it('half-open probe: after cooldown, exactly one request tries primary again', async () => {
    let clock = 10_000
    const now = () => clock
    const primaryFn = mock(async () => { throw new Error('429 rate limited') })
    const primary = makeProvider('cb-primary-3', primaryFn)
    const fallback = makeProvider('cb-fallback-3', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, now },
    })

    // Open the circuit with one exhausted-retry request.
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(3)

    // Cooldown not yet elapsed — primary not retried.
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn).toHaveBeenCalledTimes(3)

    // Advance past cooldown.
    clock += 1_001

    // Next two concurrent requests: exactly ONE becomes the probe (hits primary),
    // the other skips to fallback.
    await Promise.all([
      provider.stream(MSGS, TOOLS, OPTS),
      provider.stream(MSGS, TOOLS, OPTS),
    ])
    // Probe re-enters retry loop → 3 more primary calls.
    expect(primaryFn).toHaveBeenCalledTimes(6)
  })

  it('half-open → closed: primary success recovers fully, next requests use primary normally', async () => {
    let clock = 10_000
    const now = () => clock
    let primaryShouldFail = true
    const primaryFn = mock(async () => {
      if (primaryShouldFail) throw new Error('429 rate limited')
      return OK_RESPONSE
    })
    const primary = makeProvider('cb-primary-4', primaryFn)
    const fallback = makeProvider('cb-fallback-4', mock(async () => OK_RESPONSE))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, now },
    })

    await provider.stream(MSGS, TOOLS, OPTS)                 // opens circuit
    primaryShouldFail = false
    clock += 1_001

    // Probe succeeds → circuit closes
    const probeCalls = primaryFn.mock.calls.length
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn.mock.calls.length).toBe(probeCalls + 1) // one successful call (no retries needed)

    // Subsequent requests go straight to primary without probe gating
    await provider.stream(MSGS, TOOLS, OPTS)
    await provider.stream(MSGS, TOOLS, OPTS)
    expect(primaryFn.mock.calls.length).toBe(probeCalls + 3)
    expect(fallback.stream).toHaveBeenCalledTimes(1) // only the initial open-triggering request
  })

  it('both endpoints dead: fail fast with clear error instead of timing out', async () => {
    const primary = makeProvider('cb-primary-5', mock(async () => { throw new Error('429') }))
    const fallback = makeProvider('cb-fallback-5', mock(async () => { throw new Error('ECONNREFUSED') }))
    const provider = new FallbackProvider(primary, fallback, {
      sleepFn: noopSleep,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 },
    })

    // First request: both fail, primary + fallback each record one failure → both circuits open.
    await expect(provider.stream(MSGS, TOOLS, OPTS)).rejects.toThrow()

    // Second request: both circuits open → fail-fast with "Both providers unavailable"
    await expect(provider.stream(MSGS, TOOLS, OPTS)).rejects.toThrow(/Both providers unavailable/)
  })
})

describe('computeDelay', () => {
  it('uses Retry-After verbatim when provided (always wins)', () => {
    // Even with statusCode 429, Retry-After takes precedence
    expect(computeDelay(0, 12, 429)).toBe(12_000)
    expect(computeDelay(3, 7, null)).toBe(7_000)
  })

  it('429 without Retry-After: equal jitter with guaranteed minimum floor', () => {
    // BASE=5000. attempt=0: cap=5000, delay ∈ [2500, 5000)
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(0, null, 429)
      expect(d).toBeGreaterThanOrEqual(2500)
      expect(d).toBeLessThan(5000)
    }
  })

  it('429 backoff grows exponentially (equal jitter)', () => {
    // attempt=1: cap=10000, delay ∈ [5000, 10000)
    // attempt=2: cap=20000, delay ∈ [10000, 20000)
    for (let i = 0; i < 50; i++) {
      const d1 = computeDelay(1, null, 429)
      expect(d1).toBeGreaterThanOrEqual(5000)
      expect(d1).toBeLessThan(10_000)
      const d2 = computeDelay(2, null, 429)
      expect(d2).toBeGreaterThanOrEqual(10_000)
      expect(d2).toBeLessThan(20_000)
    }
  })

  it('429 backoff respects MAX_DELAY_MS cap', () => {
    // attempt=10 would be astronomical; cap is 30s so delay ∈ [15000, 30000)
    for (let i = 0; i < 20; i++) {
      const d = computeDelay(10, null, 429)
      expect(d).toBeGreaterThanOrEqual(15_000)
      expect(d).toBeLessThan(30_000)
    }
  })

  it('non-429 retriables keep full-jitter behavior (possibly 0ms)', () => {
    // BASE=1000. attempt=0: cap=1000, delay ∈ [0, 1000)
    let sawLowDelay = false
    for (let i = 0; i < 100; i++) {
      const d = computeDelay(0, null, 503)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(1000)
      if (d < 200) sawLowDelay = true
    }
    // With 100 tries of full jitter in [0,1000), at least one should be <200ms
    expect(sawLowDelay).toBe(true)
  })

  it('null statusCode treats as non-429 (network errors)', () => {
    for (let i = 0; i < 50; i++) {
      const d = computeDelay(1, null, null)
      // attempt=1, cap=2000, full jitter ∈ [0, 2000)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(2000)
    }
  })
})
