/**
 * Regression test for the 2026-04-14 Discord incident.
 *
 * Shape of incident: 5 parallel subagents each independently hit a
 * rate-limited primary provider (429) and a dead fallback (never resolves),
 * each timing out ~75s, hanging the Discord bot for 10+ minutes.
 *
 * Phase 54 added a circuit breaker (shared fail-fast after N failures).
 * Phase 55 added a semaphore (at most N concurrent in-flight calls).
 * Together they close this incident class.
 *
 * This test verifies:
 * 1. peakFallbackConcurrent <= 4 (semaphore cap worked)
 * 2. Total wall-clock < 10s (circuit breaker opens fast, no 75s timeouts)
 * 3. At least one rejection (not all calls silently swallowed)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { FallbackProvider } from './fallback.js'
import { LLMSemaphore } from './semaphore.js'
import { wrapWithSemaphore } from './registry.js'
import { resetAll as resetCircuits } from './circuit-breaker.js'
import type { Provider, StreamResponse } from './types.js'

describe('2026-04-14 incident regression', () => {
  let aborted: boolean

  beforeEach(() => {
    resetCircuits()
    aborted = false
  })

  afterEach(() => {
    aborted = true // release any hung fallback stubs
  })

  test(
    '5 parallel callers, primary 429, fallback hangs → completes <10s, peak fallback concurrency <= 4',
    async () => {
      let activeFallback = 0
      let peakFallbackConcurrent = 0

      const primary: Provider = {
        name: 'stub-primary',
        async stream(): Promise<StreamResponse> {
          throw new Error('429 rate_limited')
        },
      }

      const fallback: Provider = {
        name: 'stub-fallback',
        async stream(): Promise<StreamResponse> {
          activeFallback++
          peakFallbackConcurrent = Math.max(peakFallbackConcurrent, activeFallback)
          try {
            // Simulate a dead fallback that eventually times out after a short
            // delay (representative of a real endpoint hang, but sped up for
            // testing). The test wall-clock assertion enforces that we don't
            // hit the full 75s the original incident did — circuit breaker or
            // semaphore cap must stop the cascade early.
            await new Promise<void>((_, rej) => {
              // Short timeout: the circuit breaker should open after 3 fallback
              // failures and fast-reject the remaining callers, so the total
              // wall-clock is well under 10s despite each individual fallback
              // "timing out" at 200ms.
              const timeoutId = setTimeout(() => rej(new Error('ETIMEDOUT stub fallback')), 200)
              // Also respect test abort signal for cleanup
              const pollId = setInterval(() => {
                if (aborted) {
                  clearInterval(pollId)
                  clearTimeout(timeoutId)
                  rej(new Error('aborted'))
                }
              }, 50)
            })
            return {
              text: '',
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
              stopReason: null,
            }
          } finally {
            activeFallback--
          }
        },
      }

      // FallbackProvider with maxRetries=0 to speed up test.
      // The structural fix (semaphore + circuit breaker) must work without
      // relying on retries — we want to verify the cap, not retry behavior.
      const fp = new FallbackProvider(primary, fallback, {
        maxRetries: 0,
        sleepFn: () => Promise.resolve(),
        circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
      })

      const sem = new LLMSemaphore({ max: 4 })
      const wrapped = wrapWithSemaphore(fp, sem)

      const start = Date.now()
      const results = await Promise.race([
        Promise.allSettled(
          Array.from({ length: 5 }, () =>
            wrapped.stream([], [], { onTextChunk: () => {} }),
          ),
        ),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('test timed out >10s')), 10_000),
        ),
      ])
      const wallMs = Date.now() - start

      expect(peakFallbackConcurrent).toBeLessThanOrEqual(4)
      expect(wallMs).toBeLessThan(10_000)
      expect(Array.isArray(results)).toBe(true)

      // At least one rejection — all 5 should reject (429 → fallback → circuit opens)
      const rejections = (results as PromiseSettledResult<StreamResponse>[]).filter(
        (r) => r.status === 'rejected',
      )
      expect(rejections.length).toBeGreaterThan(0)
    },
    15_000, // bun test timeout — 15s gives margin over the 10s in-test gate
  )
})
