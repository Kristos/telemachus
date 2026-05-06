/**
 * Phase 63 (OBS-03): tool-error-alerts watcher tests.
 *
 * Injects deterministic now + tickerFactory so we can drive the watcher
 * through cooldown windows without real timers. sendDm is stubbed per-test.
 *
 * NO mock.module() — CLAUDE.md forbids it. __resetForTests() on both the
 * watcher module AND the metrics module in beforeEach.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import type { AuditEntry } from '../security/audit.js'
import {
  recordError,
  __resetForTests as resetMetrics,
} from '../security/tool-error-metrics.js'
import { createToolErrorAlertWatcher } from './tool-error-alerts.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function mkErr(
  tool: string,
  tsMs: number,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    kind: 'tool_error',
    sessionId: 'watcher-test',
    platform: 'darwin',
    tool,
    errorClass: 'EROFS',
    errorMessage: 'read-only',
    ts: new Date(tsMs).toISOString(),
    ...overrides,
  }
}

interface StubTicker {
  cb: () => Promise<void>
  clear: () => void
  fire: () => Promise<void>
}

function makeTickerFactory(): {
  tickers: StubTicker[]
  factory: (cb: () => Promise<void>, ms: number) => { clear: () => void }
} {
  const tickers: StubTicker[] = []
  const factory = (cb: () => Promise<void>, _ms: number) => {
    let cleared = false
    const t: StubTicker = {
      cb,
      clear: () => {
        cleared = true
      },
      fire: async () => {
        if (cleared) return
        await cb()
      },
    }
    tickers.push(t)
    return { clear: t.clear }
  }
  return { tickers, factory }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('createToolErrorAlertWatcher', () => {
  beforeEach(() => {
    resetMetrics()
  })

  test('1: 3 errors on write_file in 15m → sendDm called once with count + class', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (userId: string, text: string) => {
      sent.push({ userId, text })
    }
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkErr('write_file', now - 1000, { errorClass: 'EROFS' }), nowFn)
    recordError(mkErr('write_file', now - 500, { errorClass: 'EROFS' }), nowFn)
    recordError(mkErr('write_file', now - 100, { errorClass: 'EROFS' }), nowFn)

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()
    await tickers[0]!.fire()

    expect(sent.length).toBe(1)
    expect(sent[0]!.userId).toBe('owner-1')
    expect(sent[0]!.text).toContain('write_file')
    expect(sent[0]!.text).toContain('3')
    expect(sent[0]!.text).toContain('EROFS')
    watcher.stop()
  })

  test('2: 4th error within 30m cooldown → sendDm NOT called again', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    let now = 1_000_000
    const nowFn = () => now

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()

    // First triggering batch
    recordError(mkErr('glob', now - 1000), nowFn)
    recordError(mkErr('glob', now - 500), nowFn)
    recordError(mkErr('glob', now - 100), nowFn)
    await tickers[0]!.fire()
    expect(sent.length).toBe(1)

    // 10 minutes later — still in 30m cooldown
    now += 10 * 60_000
    recordError(mkErr('glob', now - 100), nowFn)
    await tickers[0]!.fire()
    expect(sent.length).toBe(1) // no new DM

    watcher.stop()
  })

  test('3: after 30m cooldown expires AND threshold met → new DM', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    let now = 1_000_000
    const nowFn = () => now

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()

    recordError(mkErr('glob', now - 1000), nowFn)
    recordError(mkErr('glob', now - 500), nowFn)
    recordError(mkErr('glob', now - 100), nowFn)
    await tickers[0]!.fire()
    expect(sent.length).toBe(1)

    // 40 minutes later — cooldown expired (30m default)
    now += 40 * 60_000
    recordError(mkErr('glob', now - 30_000), nowFn)
    recordError(mkErr('glob', now - 20_000), nowFn)
    recordError(mkErr('glob', now - 10_000), nowFn)
    await tickers[0]!.fire()
    expect(sent.length).toBe(2)

    watcher.stop()
  })

  test('4: distinct tools reach threshold → one DM per tool, independent cooldowns', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    const now = 1_000_000
    const nowFn = () => now

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()

    for (let i = 0; i < 3; i++) recordError(mkErr('write_file', now - i - 10), nowFn)
    for (let i = 0; i < 3; i++) recordError(mkErr('glob', now - i - 20, { errorClass: 'EBADF' }), nowFn)
    await tickers[0]!.fire()

    expect(sent.length).toBe(2)
    const tools = sent.map((s) => s.text).join('\n')
    expect(tools).toContain('write_file')
    expect(tools).toContain('glob')
    watcher.stop()
  })

  test('5: threshold NOT reached (2 errors) → sendDm not called', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkErr('write_file', now - 100), nowFn)
    recordError(mkErr('write_file', now - 50), nowFn)

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()
    await tickers[0]!.fire()

    expect(sent.length).toBe(0)
    watcher.stop()
  })

  test('6: stop() clears the interval — tick callback never fires after stop', async () => {
    let tickCount = 0
    const sendDm = async () => {
      tickCount++
    }
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkErr('write_file', now - 100), nowFn)
    recordError(mkErr('write_file', now - 50), nowFn)
    recordError(mkErr('write_file', now - 10), nowFn)

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()
    watcher.stop()
    // Even firing the stored callback post-stop should do nothing (the stub
    // ticker respects its cleared flag).
    await tickers[0]!.fire()
    expect(tickCount).toBe(0)
  })

  test('7: sendDm throws → watcher swallows and continues', async () => {
    let attempts = 0
    const sendDm = async () => {
      attempts++
      throw new Error('discord API 500')
    }
    const now = 1_000_000
    const nowFn = () => now
    recordError(mkErr('glob', now - 100), nowFn)
    recordError(mkErr('glob', now - 50), nowFn)
    recordError(mkErr('glob', now - 10), nowFn)

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()
    await tickers[0]!.fire()

    expect(attempts).toBe(1) // watcher tried, failed, didn't crash
    watcher.stop()
  })

  test('8: config overrides defaults (threshold=5, window=15m, cooldown=10m)', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    const now = 1_000_000
    const nowFn = () => now
    // 4 errors — under the custom threshold of 5
    for (let i = 0; i < 4; i++) recordError(mkErr('bash', now - i - 10), nowFn)

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
      config: {
        perToolThreshold: 5,
        perToolWindowMs: 15 * 60_000,
        cooldownMs: 10 * 60_000,
      },
    })
    watcher.start()
    await tickers[0]!.fire()
    expect(sent.length).toBe(0)

    // Now push past 5 and re-fire
    recordError(mkErr('bash', now - 5), nowFn)
    await tickers[0]!.fire()
    expect(sent.length).toBe(1)
    watcher.stop()
  })

  test('9: empty ratePerTool result → no DMs, no errors', async () => {
    const sent: Array<{ userId: string; text: string }> = []
    const sendDm = async (u: string, t: string) => {
      sent.push({ userId: u, text: t })
    }
    const now = 1_000_000
    const nowFn = () => now

    const { tickers, factory } = makeTickerFactory()
    const watcher = createToolErrorAlertWatcher({
      sendDm,
      ownerId: 'owner-1',
      now: nowFn,
      tickerFactory: factory,
    })
    watcher.start()
    await tickers[0]!.fire()
    expect(sent.length).toBe(0)
    watcher.stop()
  })
})
