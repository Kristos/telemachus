/**
 * Phase 34-02 (OPS-04): Unit tests for checkLlmEndpoint.
 *
 * Uses real Bun.serve HTTP servers (not mocked fetch) to test actual
 * connectivity, error responses, and timeout behavior.
 * All tests verify the never-throws guarantee.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { checkLlmEndpoint } from '../health-check.js'

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  if (server) {
    server.stop()
    server = null
  }
})

describe('checkLlmEndpoint', () => {
  test('returns ok:true for reachable endpoint (OPS-04 happy path)', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/v1/models') {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })

    const result = await checkLlmEndpoint(`http://localhost:${server.port}/v1`)

    expect(result).toEqual({ ok: true })
  })

  test('returns ok:false with error for non-200 response', async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('internal error', { status: 500 })
      },
    })

    const result = await checkLlmEndpoint(`http://localhost:${server.port}/v1`)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('500')
  })

  test('returns ok:false for connection refused (no throw)', async () => {
    // Port 19999 — nothing should be listening there
    const result = await checkLlmEndpoint('http://localhost:19999/v1')

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    // Must not throw — result is always returned
  })

  test('returns ok:false for timeout (no throw)', async () => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        // Delay 2 seconds — well beyond the 100ms timeout we'll pass
        await new Promise((r) => setTimeout(r, 2000))
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      },
    })

    const result = await checkLlmEndpoint(`http://localhost:${server.port}/v1`, 100)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    // Must not throw — result is always returned
  })

  test('never throws for completely invalid URL', async () => {
    // AbortSignal.timeout or fetch itself may throw on malformed URL —
    // checkLlmEndpoint's try/catch must absorb it.
    const result = await checkLlmEndpoint('http://[invalid')

    expect(result.ok).toBe(false)
    // Must be an object with ok:false — not an exception
    expect(typeof result).toBe('object')
  })
})
