/**
 * Phase 69 Plan 02: Tests for grammy bot core.
 *
 * TGCORE-01 — Owner allowlist (tests 1-4): verifies createOwnerGuard middleware
 * TGCORE-03 — deleteWebhook ordering (tests 5-6): verifies runStartupSequence
 * TGCORE-04 — SIGTERM graceful drain (tests 7-9): verifies createShutdownHandler
 *
 * Uses dependency injection (no mock.module) so the CLAUDE.md constraint is satisfied.
 * Helpers accept queue functions as parameters, making mocking trivial with bun:test mock().
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import {
  createOwnerGuard,
  createShutdownHandler,
  runStartupSequence,
} from '../bot.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal grammy-like Context object for tests. */
function makeCtx(opts: {
  fromId?: number
  chatId?: number
  reply?: ReturnType<typeof mock>
}): { from?: { id: number }; chat?: { id: number }; reply: ReturnType<typeof mock> } {
  return {
    ...(opts.fromId !== undefined ? { from: { id: opts.fromId } } : {}),
    ...(opts.chatId !== undefined ? { chat: { id: opts.chatId } } : {}),
    reply: opts.reply ?? mock(async () => {}),
  }
}

// ── TGCORE-01: Owner allowlist ────────────────────────────────────────────────

describe('TGCORE-01: createOwnerGuard — owner allowlist', () => {
  const OWNER_ID = '12345'

  it('test 1: calls next() when ctx.from.id matches ownerChatId', async () => {
    const guard = createOwnerGuard(OWNER_ID)
    const next = mock(async () => {})
    const ctx = makeCtx({ fromId: 12345, chatId: 99999 })
    await guard(ctx as never, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('test 2: does NOT call next() when ctx.from.id differs from ownerChatId (silent drop)', async () => {
    const guard = createOwnerGuard(OWNER_ID)
    const next = mock(async () => {})
    const ctx = makeCtx({ fromId: 99999, chatId: 99999 })
    await guard(ctx as never, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('test 3: does NOT call next() when ctx.from is undefined', async () => {
    const guard = createOwnerGuard(OWNER_ID)
    const next = mock(async () => {})
    const ctx = makeCtx({ chatId: 12345 })  // no fromId → ctx.from is undefined
    await guard(ctx as never, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('test 4: uses ctx.from.id (not ctx.chat.id) — chat.id matches owner but from.id does not', async () => {
    const guard = createOwnerGuard(OWNER_ID)
    const next = mock(async () => {})
    // chat.id matches ownerChatId but from.id is different — should NOT call next()
    const ctx = makeCtx({ fromId: 99999, chatId: 12345 })
    await guard(ctx as never, next)
    expect(next).not.toHaveBeenCalled()
  })
})

// ── TGCORE-03: deleteWebhook ordering ────────────────────────────────────────

describe('TGCORE-03: runStartupSequence — deleteWebhook before bot.start()', () => {
  it('test 5: calls deleteWebhook BEFORE start() — verified via call order index', async () => {
    const callOrder: string[] = []

    const deleteWebhook = mock(async (_params: { drop_pending_updates: boolean }) => {
      callOrder.push('deleteWebhook')
    })
    const start = mock(async () => {
      callOrder.push('start')
    })

    await runStartupSequence({ deleteWebhook, start })

    const deleteWebhookIndex = callOrder.indexOf('deleteWebhook')
    const startIndex = callOrder.indexOf('start')

    expect(deleteWebhookIndex).toBeGreaterThanOrEqual(0)
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(deleteWebhookIndex).toBeLessThan(startIndex)
  })

  it('test 6: deleteWebhook is called with drop_pending_updates: true', async () => {
    let capturedParams: unknown = null

    const deleteWebhook = mock(async (params: { drop_pending_updates: boolean }) => {
      capturedParams = params
    })
    const start = mock(async () => {})

    await runStartupSequence({ deleteWebhook, start })

    expect(deleteWebhook).toHaveBeenCalledTimes(1)
    expect(capturedParams).toEqual({ drop_pending_updates: true })
  })
})

// ── TGCORE-04: SIGTERM graceful drain ─────────────────────────────────────────

describe('TGCORE-04: createShutdownHandler — SIGTERM graceful drain', () => {
  let setDraining: ReturnType<typeof mock>
  let hasPendingTurns: ReturnType<typeof mock>
  let drainAllTurns: ReturnType<typeof mock>
  let botStop: ReturnType<typeof mock>

  beforeEach(() => {
    setDraining = mock((_b: boolean) => {})
    drainAllTurns = mock(async (_ms: number) => {})
    botStop = mock(async () => {})
  })

  it('test 7: shutdown handler calls setDraining(true), drainAllTurns, then bot.stop() when hasPendingTurns=true', async () => {
    const callOrder: string[] = []

    setDraining = mock((_b: boolean) => { callOrder.push('setDraining') })
    hasPendingTurns = mock(() => { callOrder.push('hasPendingTurns'); return true })
    drainAllTurns = mock(async (_ms: number) => { callOrder.push('drainAllTurns') })
    botStop = mock(async () => { callOrder.push('stop') })

    const shutdown = createShutdownHandler({
      bot: { stop: botStop },
      queue: { setDraining, hasPendingTurns, drainAllTurns },
      drainTimeoutMs: 1000,
    })

    await shutdown()

    expect(callOrder[0]).toBe('setDraining')
    expect(callOrder).toContain('drainAllTurns')
    expect(callOrder[callOrder.length - 1]).toBe('stop')
  })

  it('test 8: when hasPendingTurns() returns false, skips drainAllTurns but still calls bot.stop()', async () => {
    hasPendingTurns = mock(() => false)

    const shutdown = createShutdownHandler({
      bot: { stop: botStop },
      queue: { setDraining, hasPendingTurns, drainAllTurns },
    })

    await shutdown()

    expect(setDraining).toHaveBeenCalledWith(true)
    expect(drainAllTurns).not.toHaveBeenCalled()
    expect(botStop).toHaveBeenCalledTimes(1)
  })

  it('test 9: drainTimeoutMs defaults to 30_000 when not specified', async () => {
    hasPendingTurns = mock(() => true)

    let capturedTimeout: number | undefined
    drainAllTurns = mock(async (ms: number) => { capturedTimeout = ms })

    const shutdown = createShutdownHandler({
      bot: { stop: botStop },
      queue: { setDraining, hasPendingTurns, drainAllTurns },
      // drainTimeoutMs intentionally omitted
    })

    await shutdown()

    expect(capturedTimeout).toBe(30_000)
  })
})
