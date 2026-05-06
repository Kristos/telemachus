/**
 * Process-wide LLM inflight semaphore — Phase 55 (CONC-01, CONC-02).
 *
 * Problem: on 2026-04-14, five parallel subagents each independently hit a
 * rate-limited primary and a dead fallback endpoint, each timing out ~75s,
 * hanging the Discord bot for 10+ minutes.
 *
 * Phase 54 added a shared circuit breaker (fail-fast once N failures observed).
 * This semaphore is the complementary ceiling: even with circuits OPEN, no more
 * than `max` provider.stream() calls can ever be simultaneously in-flight.
 * Together they close the incident class.
 *
 * Relationship to circuit-breaker.ts: semaphore.acquire() runs BEFORE the
 * circuit check inside FallbackProvider. Once a slot is held, the caller
 * proceeds into the circuit check and then the actual HTTP request.
 *
 * Usage: see registry.ts — createProvider wraps every returned Provider with
 * wrapWithSemaphore using the process-wide singleton _semaphore.
 */

import { appendAuditEntry } from '../security/audit.js'

export interface LLMSemaphoreOptions {
  /** Max concurrent holders. Must be >= 1. */
  max: number
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number
  /**
   * Wait-time threshold in ms above which a provider_queue_wait audit fires.
   * Default 500.
   */
  auditThresholdMs?: number
}

interface QueueEntry {
  resolve: () => void
  enqueuedAt: number
  providerName: string
}

export class LLMSemaphore {
  private readonly max: number
  private readonly nowFn: () => number
  private readonly auditThresholdMs: number
  private active = 0
  private readonly queue: QueueEntry[] = []

  constructor(opts: LLMSemaphoreOptions) {
    this.max = Math.max(1, opts.max)
    this.nowFn = opts.now ?? Date.now
    this.auditThresholdMs = opts.auditThresholdMs ?? 500
  }

  /**
   * Acquire a slot. Resolves when a slot is free. Caller MUST call the
   * returned release() exactly once (guarded against double-release internally).
   * providerName is recorded on the queue-wait audit event if wait > threshold.
   */
  async acquire(providerName: string): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return this.makeRelease()
    }

    // No slot available — enqueue and wait
    const enqueuedAt = this.nowFn()
    return new Promise<() => void>((resolve) => {
      this.queue.push({
        resolve: () => {
          const waitMs = this.nowFn() - enqueuedAt
          if (waitMs > this.auditThresholdMs) {
            // Best-effort audit — never await, never crash
            void appendAuditEntry({
              ts: new Date().toISOString(),
              kind: 'provider_queue_wait',
              sessionId: 'semaphore',
              platform: process.platform,
              waitMs,
              queueDepth: this.queue.length,
              providerName,
            })
          }
          resolve(this.makeRelease())
        },
        enqueuedAt,
        providerName,
      })
    })
  }

  /** Test helper — current queue depth (waiters, not holders). */
  queueDepth(): number {
    return this.queue.length
  }

  /** Test helper — current active holder count. */
  activeCount(): number {
    return this.active
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (this.queue.length > 0) {
        // FIFO: shift the earliest waiter and grant it the slot
        const next = this.queue.shift()!
        this.active++
        next.resolve()
      }
    }
  }
}
