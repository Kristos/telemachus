/**
 * FallbackProvider — wraps a primary Provider and retries with a fallback
 * on transient errors (401, 429, 500, 502, 503, 529, network errors).
 *
 * Designed for the Discord bot where the primary GLM cloud endpoint (api.z.ai)
 * can go down, and the local llamacpp rig is a viable fallback.
 *
 * Behaviour:
 * - Retriable errors (429, 529, 5xx, network) trigger exponential backoff with
 *   jitter for up to `maxRetries` attempts before switching to the fallback.
 * - If the error contains a `retry-after` value (seconds), that delay is used
 *   instead of computed backoff.
 * - Every fallback switch writes a `provider_switch` audit entry.
 * - Non-retriable errors (400, 401, etc. when not in retriable set) throw immediately.
 *
 * Usage: wrap in createProvider when a fallback config exists.
 */

import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse } from './types.js'
import { appendAuditEntry } from '../security/audit.js'
import {
  tryAcquire,
  recordSuccess,
  recordFailure,
  snapshot as circuitSnapshot,
} from './circuit-breaker.js'

/** HTTP status codes that trigger retry + fallback (transient / overload). */
const RETRIABLE_CODES = new Set([429, 500, 502, 503, 529])

/** Status codes that trigger immediate fallback without retry (auth failures). */
const IMMEDIATE_FALLBACK_CODES = new Set([401])

const BASE_DELAY_MS = 1000
/**
 * Rate limits are typically minute-scale. When the server returns 429 without
 * a Retry-After header, "wait 0-1s and retry" just burns the attempt budget.
 * Use a significantly longer floor and equal-jitter (not full-jitter) so there
 * is a guaranteed minimum wait.
 */
const RATE_LIMIT_BASE_DELAY_MS = 5000
const MAX_DELAY_MS = 30_000

/** Extract the first retriable HTTP status code from an error message. */
function extractStatusCode(err: unknown): number | null {
  if (!(err instanceof Error)) return null
  const match = err.message.match(/\b(401|429|500|502|503|529)\b/)
  return match ? parseInt(match[1], 10) : null
}

/** Extract Retry-After value in seconds from error (header property or message). */
function extractRetryAfter(err: unknown): number | null {
  if (!(err instanceof Error)) return null

  // Check if error has a headers property (Anthropic SDK includes headers in error objects)
  const errAsAny = err as Record<string, unknown>
  if (errAsAny['headers'] && typeof errAsAny['headers'] === 'object') {
    const headers = errAsAny['headers'] as Record<string, string>
    const retryAfterHeader = headers['retry-after'] ?? headers['Retry-After']
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10)
      if (!isNaN(parsed)) return parsed
    }
  }

  // Fallback: parse from error message
  const match = err.message.match(/retry-after:\s*(\d+)/i)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Compute delay in ms for a retry attempt.
 *
 * Resolution order:
 *   1. Server-provided Retry-After → use verbatim (always correct).
 *   2. HTTP 429 without Retry-After → longer floor + equal jitter, because
 *      rate limits are minute-scale and the previous 0-1s delays were just
 *      burning retries without actually waiting for the limit to clear.
 *   3. Other retriable errors (5xx, network) → exponential full-jitter as
 *      before (AWS canonical "Full Jitter" algorithm, good for thundering
 *      herds against transient server errors).
 */
export function computeDelay(
  attempt: number,
  retryAfterSeconds: number | null,
  statusCode: number | null = null,
): number {
  if (retryAfterSeconds !== null) {
    return retryAfterSeconds * 1000
  }
  if (statusCode === 429) {
    const cap = Math.min(RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS)
    // Equal jitter: min guaranteed cap/2, plus 0..cap/2 random.
    return cap / 2 + Math.random() * (cap / 2)
  }
  // Full jitter for non-429 retriables.
  const cap = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS)
  return Math.random() * cap
}

function isRetriableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message

  // Check for retriable HTTP status codes
  const code = extractStatusCode(err)
  if (code !== null && RETRIABLE_CODES.has(code)) return true

  // Network-level failures
  if (msg.includes('ECONNREFUSED')) return true
  if (msg.includes('ECONNRESET')) return true
  if (msg.includes('ETIMEDOUT')) return true
  if (msg.includes('fetch failed')) return true
  if (msg.includes('Connection error')) return true
  if (msg.includes('network')) return true

  return false
}

function isImmediateFallbackError(err: unknown): boolean {
  const code = extractStatusCode(err)
  return code !== null && IMMEDIATE_FALLBACK_CODES.has(code)
}

export interface FallbackProviderOptions {
  /** Maximum number of retry attempts before switching to fallback. Default: 2. */
  maxRetries?: number
  /** Injectable sleep function for testing. Default: Bun.sleep. */
  sleepFn?: (ms: number) => Promise<void>
  /**
   * Called when fallback becomes active (true) or primary recovers (false).
   * Reserved for Phase 45-02 TUI indicator wiring.
   */
  onFallbackActive?: (active: boolean) => void
  /**
   * Circuit-breaker configuration. When the primary (or fallback) has
   * produced N consecutive failures, subsequent requests skip it for a
   * cooldown window — preventing concurrent callers from all hammering a
   * dead endpoint (the 2026-04-14 incident). State is shared at the
   * circuit-breaker module level, keyed by provider.name.
   */
  circuitBreaker?: {
    failureThreshold?: number   // default 3
    cooldownMs?: number         // default 30_000
    now?: () => number          // injectable for tests
  }
}

export class FallbackProvider implements Provider {
  readonly name: string
  private readonly primary: Provider
  private readonly fallback: Provider
  private readonly maxRetries: number
  private readonly sleepFn: (ms: number) => Promise<void>
  private onFallbackActiveCb?: (active: boolean) => void
  private readonly circuitOpts: {
    failureThreshold?: number
    cooldownMs?: number
    now?: () => number
  }

  constructor(primary: Provider, fallback: Provider, opts: FallbackProviderOptions = {}) {
    this.primary = primary
    this.fallback = fallback
    this.name = `${primary.name}→${fallback.name}`
    this.maxRetries = opts.maxRetries ?? 2
    this.sleepFn = opts.sleepFn ?? ((ms) => Bun.sleep(ms))
    this.onFallbackActiveCb = opts.onFallbackActive
    this.circuitOpts = opts.circuitBreaker ?? {}
  }

  /** Wire a callback to receive fallback state changes (true = on fallback, false = primary resumed). */
  setOnFallbackActive(cb: (active: boolean) => void): void {
    this.onFallbackActiveCb = cb
  }

  /**
   * Emit a circuit_state_change audit entry. Best-effort — never awaited.
   * Always called AFTER the state transition so `toState` reflects current state.
   */
  private auditStateChange(
    providerName: string,
    fromState: string,
    toState: string,
    reason: 'threshold_reached' | 'probe_failed' | 'probe_succeeded' | 'recovered',
    consecutiveFailures: number,
  ): void {
    void appendAuditEntry({
      ts: new Date().toISOString(),
      kind: 'circuit_state_change',
      sessionId: 'fallback',
      platform: process.platform,
      circuitProvider: providerName,
      circuitFromState: fromState,
      circuitToState: toState,
      circuitReason: reason,
      consecutiveFailures,
    })
  }

  /**
   * COST-06 (Phase 61): delegate token counting to primary; fall through to
   * fallback on primary error. Unlike stream() this does NOT use the circuit
   * breaker — countTokens is a cheap query (local for openai-compat, single
   * beta-endpoint call for Anthropic) and shouldn't participate in the
   * provider-health state machine.
   */
  async countTokens(messages: Message[]): Promise<number> {
    if (typeof this.primary.countTokens === 'function') {
      try {
        return await this.primary.countTokens(messages)
      } catch {
        // Fall through to fallback.
      }
    }
    if (typeof this.fallback.countTokens === 'function') {
      return await this.fallback.countTokens(messages)
    }
    throw new Error(
      `FallbackProvider.countTokens: neither ${this.primary.name} nor ${this.fallback.name} support countTokens`,
    )
  }

  async stream(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
  ): Promise<StreamResponse> {
    let lastErr: unknown = null
    let triggerCode: number | null = null

    // Circuit-breaker: if primary is OPEN and still in cooldown, skip the
    // retry loop entirely and go straight to fallback. If HALF_OPEN and
    // another caller already has the probe, also skip.
    const primaryDecision = tryAcquire(this.primary.name, this.circuitOpts)
    if (primaryDecision === 'skip') {
      process.stderr.write(
        `[fallback] circuit open for ${this.primary.name}, skipping to ${this.fallback.name}\n`,
      )
      return this.attemptFallback(messages, tools, opts, 'circuit_open', null)
    }

    // primaryDecision === 'send': we hold the "slot" (if half_open, we ARE the probe).
    // Attempt with retries.
    const wasHalfOpen = circuitSnapshot(this.primary.name) === 'half_open'

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.primary.stream(messages, tools, opts)
        // Primary succeeded
        if (wasHalfOpen) {
          this.auditStateChange(this.primary.name, 'half_open', 'closed', 'probe_succeeded', 0)
        }
        recordSuccess(this.primary.name)
        this.onFallbackActiveCb?.(false)
        return result
      } catch (err) {
        lastErr = err
        const code = extractStatusCode(err)

        // Immediate fallback for auth errors (no retry)
        if (isImmediateFallbackError(err)) {
          triggerCode = code
          break
        }

        if (!isRetriableError(err)) {
          // Non-retriable errors (400, invalid prompt, etc.) are caller bugs,
          // not endpoint-health issues. Do NOT count these against the circuit;
          // we want the next request to hit the primary fresh.
          throw err
        }

        if (code !== null) triggerCode = code

        // If we have more retries, sleep and retry
        if (attempt < this.maxRetries) {
          const retryAfterSeconds = extractRetryAfter(err)
          const delayMs = computeDelay(attempt, retryAfterSeconds, code)
          const errMsg = err instanceof Error ? err.message : String(err)
          process.stderr.write(
            `[fallback] ${this.primary.name} failed (${errMsg}), retry ${attempt + 1}/${this.maxRetries} in ${Math.round(delayMs)}ms\n`,
          )
          await this.sleepFn(delayMs)
        }
      }
    }

    // All retries exhausted — record the failure in the circuit breaker.
    // This is one "request-level" failure, not one per retry; the circuit
    // counts consecutive requests that ended in exhaustion/immediate-fallback.
    const r = recordFailure(this.primary.name, this.circuitOpts)
    if (r.justOpened) {
      this.auditStateChange(
        this.primary.name,
        wasHalfOpen ? 'half_open' : 'closed',
        'open',
        wasHalfOpen ? 'probe_failed' : 'threshold_reached',
        this.maxRetries + 1,
      )
    }

    return this.attemptFallback(messages, tools, opts, 'retries_exhausted', triggerCode, lastErr)
  }

  /**
   * Call the fallback provider. Guarded by its own circuit-breaker state:
   * if the fallback is ALSO known to be dead, throw the original primary
   * error immediately instead of waiting for another timeout (the 2026-04-14
   * incident's worst case — both endpoints dead, every request times out).
   */
  private async attemptFallback(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
    reason: 'circuit_open' | 'retries_exhausted',
    triggerCode: number | null,
    lastPrimaryErr?: unknown,
  ): Promise<StreamResponse> {
    // provider_switch audit — preserves existing Phase 45 contract.
    if (reason === 'retries_exhausted') {
      const errMsg =
        lastPrimaryErr instanceof Error ? lastPrimaryErr.message : String(lastPrimaryErr ?? '')
      process.stderr.write(
        `[fallback] ${this.primary.name} failed after ${this.maxRetries} retries (${errMsg}), switching to ${this.fallback.name}\n`,
      )
      void appendAuditEntry({
        ts: new Date().toISOString(),
        kind: 'provider_switch',
        sessionId: 'fallback',
        platform: process.platform,
        primaryProvider: this.primary.name,
        fallbackProvider: this.fallback.name,
        triggerCode: triggerCode ?? undefined,
        retryAttempts: this.maxRetries,
      })
    }

    this.onFallbackActiveCb?.(true)

    const fallbackDecision = tryAcquire(this.fallback.name, this.circuitOpts)
    if (fallbackDecision === 'skip') {
      // Both endpoints appear dead — fail fast instead of timing out.
      const err = new Error(
        `Both providers unavailable: ${this.primary.name} (circuit: ${circuitSnapshot(this.primary.name)}) and ${this.fallback.name} (circuit: ${circuitSnapshot(this.fallback.name)})`,
      )
      throw err
    }

    const fallbackWasHalfOpen = circuitSnapshot(this.fallback.name) === 'half_open'
    try {
      const result = await this.fallback.stream(messages, tools, opts)
      if (fallbackWasHalfOpen) {
        this.auditStateChange(
          this.fallback.name,
          'half_open',
          'closed',
          'probe_succeeded',
          0,
        )
      }
      recordSuccess(this.fallback.name)
      return result
    } catch (err) {
      const r = recordFailure(this.fallback.name, this.circuitOpts)
      if (r.justOpened) {
        this.auditStateChange(
          this.fallback.name,
          fallbackWasHalfOpen ? 'half_open' : 'closed',
          'open',
          fallbackWasHalfOpen ? 'probe_failed' : 'threshold_reached',
          this.maxRetries + 1,
        )
      }
      throw err
    }
  }
}
