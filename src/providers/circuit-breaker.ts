/**
 * Per-provider circuit breaker — shared across concurrent FallbackProvider calls.
 *
 * Problem it solves: on 2026-04-14, five parallel subagents each independently
 * hit a rate-limited primary endpoint and a dead fallback endpoint, each
 * timing out for ~75s × retry count. The bot hung in "typing" for 10 minutes
 * because the FallbackProvider's retry loop is *per-request* and has no way
 * to know that four other concurrent requests already proved the endpoint is
 * down.
 *
 * The circuit breaker gives all concurrent requests a shared view:
 *   - CLOSED     — endpoint is healthy, send requests normally
 *   - OPEN       — endpoint is down; skip it without trying (fail fast)
 *   - HALF_OPEN  — cooldown elapsed; ONE probe is allowed; others still skip
 *
 * Transitions:
 *   CLOSED     → OPEN       after `failureThreshold` consecutive failures
 *   OPEN       → HALF_OPEN  after `cooldownMs` elapsed since opening
 *   HALF_OPEN  → CLOSED     on probe success (resets counters)
 *   HALF_OPEN  → OPEN       on probe failure (restarts cooldown)
 *   any        → CLOSED     on any success (self-healing)
 *
 * Shared module-level state (`circuits` map keyed by provider name). This is
 * intentional — it's what makes the shared view work. Tests can reset with
 * `resetAll()`.
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. Default 3. */
  failureThreshold?: number
  /** How long the circuit stays fully open before transitioning to half-open. Default 30s. */
  cooldownMs?: number
  /** Injectable clock for deterministic testing. Default Date.now. */
  now?: () => number
}

interface CircuitRecord {
  state: CircuitState
  consecutiveFailures: number
  openedAt: number            // ms timestamp when the circuit opened
  probeInFlight: boolean      // true between tryAcquireProbe() and recordProbeResult()
}

const DEFAULTS = {
  failureThreshold: 3,
  cooldownMs: 30_000,
} as const

/**
 * Module-level circuit registry. All FallbackProvider instances (and tests)
 * share this state — that is the entire point of the breaker.
 *
 * Keyed by provider.name (e.g. "anthropic", "openai-compat→llamacpp" is NOT
 * a key — we record the INNER primary/fallback names separately).
 */
const circuits = new Map<string, CircuitRecord>()

function getRecord(providerName: string): CircuitRecord {
  let rec = circuits.get(providerName)
  if (rec === undefined) {
    rec = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false }
    circuits.set(providerName, rec)
  }
  return rec
}

/** Test helper — clears all circuit state. Do not call in production paths. */
export function resetAll(): void {
  circuits.clear()
}

/** Read-only snapshot for diagnostics / audit logging. */
export function snapshot(providerName: string): CircuitState {
  return circuits.get(providerName)?.state ?? 'closed'
}

/** Read-only full snapshot used by the provider for audit fields. */
export function getDetails(providerName: string): Readonly<{
  state: CircuitState
  consecutiveFailures: number
  openedAt: number
}> {
  const rec = getRecord(providerName)
  return { state: rec.state, consecutiveFailures: rec.consecutiveFailures, openedAt: rec.openedAt }
}

/**
 * Ask the breaker whether a request may be sent to `providerName`.
 *
 * Returns:
 *   'send'     — CLOSED, or HALF_OPEN and this caller acquired the probe slot
 *   'skip'     — OPEN, or HALF_OPEN with the probe already in flight
 *
 * Callers that get 'send' MUST later call `recordSuccess` or `recordFailure`.
 * Callers that get 'skip' should immediately fall back (or fail fast if
 * they have no fallback).
 */
export function tryAcquire(
  providerName: string,
  opts: CircuitBreakerOptions = {},
): 'send' | 'skip' {
  const cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs
  const now = opts.now ?? Date.now
  const rec = getRecord(providerName)

  if (rec.state === 'closed') return 'send'

  if (rec.state === 'open') {
    // Has the cooldown elapsed? If yes, transition to half_open and this caller becomes the probe.
    if (now() - rec.openedAt >= cooldownMs) {
      rec.state = 'half_open'
      rec.probeInFlight = true
      return 'send'
    }
    return 'skip'
  }

  // half_open: only one probe at a time
  if (rec.probeInFlight) return 'skip'
  rec.probeInFlight = true
  return 'send'
}

/**
 * Record a successful response from `providerName`. Closes the circuit and
 * clears failure counters.
 */
export function recordSuccess(providerName: string): void {
  const rec = getRecord(providerName)
  rec.state = 'closed'
  rec.consecutiveFailures = 0
  rec.openedAt = 0
  rec.probeInFlight = false
}

/**
 * Record a failed response from `providerName`.
 *
 * Returns the state after the transition so the caller can log / audit.
 * If the circuit is now OPEN and it just transitioned on this call, the
 * caller should emit a circuit_state_change audit entry.
 */
export function recordFailure(
  providerName: string,
  opts: CircuitBreakerOptions = {},
): { state: CircuitState; justOpened: boolean } {
  const failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold
  const now = opts.now ?? Date.now
  const rec = getRecord(providerName)

  rec.consecutiveFailures += 1
  rec.probeInFlight = false

  const wasClosed = rec.state === 'closed'
  const wasHalfOpen = rec.state === 'half_open'

  if (rec.state === 'half_open') {
    // Probe failed — reopen with fresh cooldown window
    rec.state = 'open'
    rec.openedAt = now()
    return { state: 'open', justOpened: true }
  }

  if (wasClosed && rec.consecutiveFailures >= failureThreshold) {
    rec.state = 'open'
    rec.openedAt = now()
    return { state: 'open', justOpened: true }
  }

  // Still closed, counters incremented but threshold not met
  void wasHalfOpen
  return { state: rec.state, justOpened: false }
}
