/**
 * Per-RouterProvider-instance circuit breaker for the classifier path (COST-05).
 *
 * Mirrors the STATE MACHINE of src/providers/circuit-breaker.ts (closed →
 * open → half_open → closed | open) but holds its state on the INSTANCE,
 * NOT in module-scope.
 *
 * CONTEXT.md §"COST-05 circuit breaker parameters":
 *   "per-router-instance state (not global) to tolerate multi-process deployment."
 *
 * Multi-process rationale: kc can run concurrently as Discord runner + CLI on
 * separate shells. A classifier rate-limit window observed by one process
 * should not silently suppress classifier calls on a sibling process.
 * Module-level state (as used by circuit-breaker.ts for FallbackProvider)
 * intentionally IS shared; router breaker intentionally is NOT.
 *
 * Transitions:
 *   closed → open        after `failureThreshold` escalations within `windowMs`
 *   open → half_open     after `cooldownMs` elapsed since opening (tryAcquire trigger)
 *   half_open → closed   on probe `recordSuccess()`
 *   half_open → open     on probe `recordEscalation()` (cooldownMs doubles, cap `maxCooldownMs`)
 *   any → closed         on any `recordSuccess()` (self-heal)
 *
 * Rolling-window semantics: `recordEscalation` prunes entries older than
 * `windowMs` before comparing to threshold. Old failures don't keep tripping
 * the breaker forever.
 */
import type { CircuitState } from './circuit-breaker.js'

export interface RouterClassifierBreakerOptions {
  /** Consecutive escalations within windowMs before opening. Default 3. */
  failureThreshold?: number
  /** Rolling window length for counting escalations. Default 60_000 ms. */
  windowMs?: number
  /** Initial cooldown after first transition to open. Default 120_000 ms (2 min). */
  initialCooldownMs?: number
  /** Exponential-backoff cap for half_open→open cycles. Default 600_000 ms (10 min). */
  maxCooldownMs?: number
  /** Injectable clock for deterministic testing. Default Date.now. */
  now?: () => number
}

const DEFAULTS = {
  failureThreshold: 3,
  windowMs: 60_000,
  initialCooldownMs: 120_000,
  maxCooldownMs: 600_000,
} as const

export class RouterClassifierBreaker {
  private state: CircuitState = 'closed'
  /** Rolling-window escalation timestamps (ms epoch). */
  private escalationTimestamps: number[] = []
  /** When the current open window started. */
  private openedAt = 0
  /** Current cooldown duration; doubles on each half_open→open cycle. */
  private currentCooldownMs: number
  /** True between tryAcquire→send (half-open probe) and the next record*. */
  private probeInFlight = false
  /** Snapshot helper — value of consecutiveEscalations at last transition. */
  private consecutiveAtTransition = 0

  private readonly failureThreshold: number
  private readonly windowMs: number
  private readonly initialCooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number

  constructor(opts: RouterClassifierBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs
    this.initialCooldownMs = opts.initialCooldownMs ?? DEFAULTS.initialCooldownMs
    this.maxCooldownMs = opts.maxCooldownMs ?? DEFAULTS.maxCooldownMs
    this.now = opts.now ?? Date.now
    this.currentCooldownMs = this.initialCooldownMs
  }

  /**
   * Ask the breaker whether a classifier call may be sent.
   * Returns 'send' (proceed) or 'skip' (short-circuit to complex).
   */
  tryAcquire(): 'send' | 'skip' {
    if (this.state === 'closed') return 'send'

    if (this.state === 'open') {
      // Has the cooldown elapsed? If yes, transition to half_open and this
      // caller becomes the probe.
      if (this.now() - this.openedAt >= this.currentCooldownMs) {
        this.state = 'half_open'
        this.probeInFlight = true
        return 'send'
      }
      return 'skip'
    }

    // half_open: only one probe at a time
    if (this.probeInFlight) return 'skip'
    this.probeInFlight = true
    return 'send'
  }

  /**
   * Record a classifier escalation (timeout / error / invalid_output).
   * Returns { transition } so the caller can emit an audit entry on open.
   */
  recordEscalation(): { transition: 'none' | 'opened' | 'stay_open' } {
    const now = this.now()

    // Prune timestamps outside the rolling window.
    const cutoff = now - this.windowMs
    this.escalationTimestamps = this.escalationTimestamps.filter((t) => t >= cutoff)
    this.escalationTimestamps.push(now)

    if (this.state === 'half_open') {
      // Probe failed — reopen with exponential backoff (cap at maxCooldownMs).
      this.state = 'open'
      this.openedAt = now
      this.currentCooldownMs = Math.min(this.currentCooldownMs * 2, this.maxCooldownMs)
      this.probeInFlight = false
      this.consecutiveAtTransition = this.escalationTimestamps.length
      return { transition: 'stay_open' }
    }

    if (this.state === 'closed' && this.escalationTimestamps.length >= this.failureThreshold) {
      // Threshold reached within window — open the circuit.
      this.state = 'open'
      this.openedAt = now
      this.currentCooldownMs = this.initialCooldownMs
      this.probeInFlight = false
      this.consecutiveAtTransition = this.escalationTimestamps.length
      return { transition: 'opened' }
    }

    // Still closed, counter incremented but threshold not met.
    this.probeInFlight = false
    return { transition: 'none' }
  }

  /**
   * Record a classifier success. Resets state to closed + clears counters.
   * Self-heal: any successful classification closes the circuit immediately.
   */
  recordSuccess(): void {
    this.state = 'closed'
    this.escalationTimestamps = []
    this.openedAt = 0
    this.currentCooldownMs = this.initialCooldownMs
    this.probeInFlight = false
  }

  /** Read-only snapshot for diagnostics / audit fields. */
  snapshot(): { state: CircuitState; consecutive: number; cooldownMs: number } {
    return {
      state: this.state,
      consecutive: this.consecutiveAtTransition || this.escalationTimestamps.length,
      cooldownMs: this.currentCooldownMs,
    }
  }
}
