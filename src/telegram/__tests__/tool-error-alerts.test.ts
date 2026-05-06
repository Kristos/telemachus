/**
 * Phase 71 (TGNOTIF-03): Tests for Telegram tool-error alert watcher.
 *
 * Uses deps-injection (ratePerToolFn, getRecentErrorsFn, tickerFactory, now)
 * for deterministic tests without mock.module() or shared ring-buffer state.
 *
 * Test layout:
 *   1. threshold not reached → no alert
 *   2. threshold reached → alert sent once with tool name + count
 *   3. cooldown suppresses second alert within cooldownMs
 *   4. cooldown expired → re-fires
 *   5. threshold=0 disables watcher
 *   6. sendMessage failure logged but swallowed
 *   7. start() idempotent — only one ticker registered
 *   8. stop() cancels ticker
 */
import { describe, test, expect, mock } from 'bun:test'
import {
  createTelegramToolErrorAlertWatcher,
  type TelegramToolErrorAlertDeps,
} from '../tool-error-alerts.js'
import type { ToolErrorSample } from '../../security/tool-error-metrics.js'

// ── helpers ───────────────────────────────────────────────────────────────────

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
      clear: () => { cleared = true },
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

function makeRateFn(counts: Record<string, number>) {
  return (_windowMs: number, _nowFn?: () => number): Map<string, number> =>
    new Map(Object.entries(counts))
}

function makeRecentFn(samples: ToolErrorSample[]) {
  return (_windowMs: number, _limit: number, _nowFn?: () => number): ToolErrorSample[] => samples
}

function baseSample(tool: string): ToolErrorSample {
  return {
    ts: new Date(1_000_000).toISOString(),
    tool,
    errorClass: 'EROFS',
    errorMessage: 'read-only filesystem',
  }
}

function baseDeps(overrides: Partial<TelegramToolErrorAlertDeps> = {}): TelegramToolErrorAlertDeps {
  return {
    sendMessage: mock(async () => {}),
    now: () => 1_000_000,
    ...overrides,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('createTelegramToolErrorAlertWatcher', () => {
  test('1: threshold not reached (count=2, threshold=3) → sendMessage NOT called', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      ratePerToolFn: makeRateFn({ write_file: 2 }),
      getRecentErrorsFn: makeRecentFn([baseSample('write_file')]),
      tickerFactory: factory,
    }))
    watcher.start()
    await tickers[0]!.fire()

    expect(sent.length).toBe(0)
    watcher.stop()
  })

  test('2: threshold reached (count=3) → alert sent once with tool + count', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      ratePerToolFn: makeRateFn({ write_file: 3 }),
      getRecentErrorsFn: makeRecentFn([baseSample('write_file')]),
      tickerFactory: factory,
    }))
    watcher.start()
    await tickers[0]!.fire()

    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('write_file')
    expect(sent[0]).toContain('3')
    expect(sent[0]).toContain('failed 3 times')
    watcher.stop()
  })

  test('3: cooldown suppresses second alert within cooldownMs', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    let now = 1_000_000
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      now: () => now,
      ratePerToolFn: makeRateFn({ glob: 3 }),
      getRecentErrorsFn: makeRecentFn([baseSample('glob')]),
      tickerFactory: factory,
      config: { cooldownMs: 30 * 60_000 },
    }))
    watcher.start()

    // First tick — fires
    await tickers[0]!.fire()
    expect(sent.length).toBe(1)

    // 10 minutes later — still in 30m cooldown
    now += 10 * 60_000
    await tickers[0]!.fire()
    expect(sent.length).toBe(1) // no new alert

    watcher.stop()
  })

  test('4: cooldown expired → re-fires', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    let now = 1_000_000
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      now: () => now,
      ratePerToolFn: makeRateFn({ glob: 3 }),
      getRecentErrorsFn: makeRecentFn([baseSample('glob')]),
      tickerFactory: factory,
      config: { cooldownMs: 30 * 60_000 },
    }))
    watcher.start()

    // First tick — fires
    await tickers[0]!.fire()
    expect(sent.length).toBe(1)

    // 40 minutes later — cooldown expired (30m default)
    now += 40 * 60_000
    await tickers[0]!.fire()
    expect(sent.length).toBe(2)

    watcher.stop()
  })

  test('5: threshold=0 disables watcher — sendMessage never called even with count=10', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      ratePerToolFn: makeRateFn({ bash: 10 }),
      getRecentErrorsFn: makeRecentFn([baseSample('bash')]),
      tickerFactory: factory,
      config: { perToolThreshold: 0 },
    }))
    watcher.start()
    await tickers[0]!.fire()

    expect(sent.length).toBe(0)
    watcher.stop()
  })

  test('6: sendMessage failure is logged and swallowed — watcher keeps running', async () => {
    let attempts = 0
    const sendMessage = mock(async () => {
      attempts++
      throw new Error('telegram API 500')
    })
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      ratePerToolFn: makeRateFn({ glob: 3 }),
      getRecentErrorsFn: makeRecentFn([baseSample('glob')]),
      tickerFactory: factory,
    }))
    watcher.start()
    // Should not throw
    await tickers[0]!.fire()

    expect(attempts).toBe(1) // tried once, failed, didn't crash
    watcher.stop()
  })

  test('7: start() idempotent — calling twice registers only one ticker', () => {
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      tickerFactory: factory,
    }))
    watcher.start()
    watcher.start() // second call is no-op

    expect(tickers.length).toBe(1)
    watcher.stop()
  })

  test('8: stop() cancels ticker — tick callback never fires after stop', async () => {
    let tickCount = 0
    const sendMessage = mock(async () => { tickCount++ })
    const { tickers, factory } = makeTickerFactory()

    const watcher = createTelegramToolErrorAlertWatcher(baseDeps({
      sendMessage,
      ratePerToolFn: makeRateFn({ write_file: 3 }),
      getRecentErrorsFn: makeRecentFn([baseSample('write_file')]),
      tickerFactory: factory,
    }))
    watcher.start()
    watcher.stop()

    // Attempt to fire after stop — cleared flag prevents execution
    await tickers[0]!.fire()

    expect(tickCount).toBe(0)
  })
})
