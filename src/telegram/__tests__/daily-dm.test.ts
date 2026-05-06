/**
 * Phase 71 (TGNOTIF-01): Tests for Telegram daily-dm scheduler.
 *
 * Uses a timerFactory stub (same pattern as tickerFactory in tool-error-alerts
 * tests) to drive the scheduler deterministically without real timers.
 * loadUsageRecordsFn is injected per-test to avoid mock.module() contamination.
 *
 * Test layout:
 *   - 'fires at next targetHour UTC' — timerFactory captures callback; fire manually
 *   - 'second fire scheduled 24h after first' — first fire creates a 24h timer; fire again
 *   - 'empty records sends "No usage recorded yesterday." (or with tool-error section)'
 *   - 'non-empty records sends summary with "Daily Usage Summary" header'
 *   - 'sendMessage failure is logged and swallowed; scheduler keeps running'
 *   - 'stop() cancels pending fire'
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { startTelegramDailyDmScheduler, type TelegramDailyDmDeps } from '../daily-dm.js'
import { msUntilNextFire } from '../../discord/daily-dm.js'
import type { UsageRecord } from '../usage-store.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRecord(channelId: string, input: number, output: number): UsageRecord {
  return {
    ts: '2024-01-01T10:00:00.000Z',
    channelId,
    userId: 'user123',
    model: 'claude-3-5-sonnet',
    inputTokens: input,
    outputTokens: output,
  }
}

interface StubTimer {
  /** The fire callback registered by the scheduler (awaitable). */
  cb: () => Promise<void>
  /** Millisecond delay passed to the factory. */
  ms: number
  clear: () => void
  /** Fires the callback only if not cleared. */
  fire: () => Promise<void>
}

function makeTimerFactory(): {
  timers: StubTimer[]
  factory: (cb: () => Promise<void>, ms: number) => { clear: () => void }
} {
  const timers: StubTimer[] = []
  const factory = (cb: () => Promise<void>, ms: number) => {
    let cleared = false
    const t: StubTimer = {
      cb,
      ms,
      clear: () => { cleared = true },
      fire: async () => {
        if (cleared) return
        await cb()
      },
    }
    timers.push(t)
    return { clear: t.clear }
  }
  return { timers, factory }
}

function baseDeps(overrides: Partial<TelegramDailyDmDeps> = {}): TelegramDailyDmDeps {
  return {
    sendMessage: mock(async () => {}),
    model: 'claude-3-5-sonnet',
    targetHour: 7,
    loadUsageRecordsFn: async () => [],
    ...overrides,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('startTelegramDailyDmScheduler', () => {
  test('fires at next targetHour UTC — sendMessage called once after first fire', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    const { stop } = startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      targetHour: 7,
      timerFactory: factory,
    }))

    // Initial timer registered — matches msUntilNextFire(7)
    expect(timers.length).toBe(1)
    const now = new Date()
    expect(timers[0]!.ms).toBeCloseTo(msUntilNextFire(7, now), -3) // within 1s

    // Fire the first scheduled callback
    await timers[0]!.fire()

    // sendMessage should have been called once
    expect(sent.length).toBe(1)

    stop()
  })

  test('second fire scheduled 24h after first — sendMessage called twice', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    const { stop } = startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      timerFactory: factory,
    }))

    // Fire the first timer
    await timers[0]!.fire()
    expect(sent.length).toBe(1)

    // After first fire, a second timer should be registered at 24h
    expect(timers.length).toBe(2)
    expect(timers[1]!.ms).toBe(24 * 3_600_000)

    // Fire the second timer
    await timers[1]!.fire()
    expect(sent.length).toBe(2)

    stop()
  })

  test('empty records sends "No usage recorded yesterday." (or with tool-error section)', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      loadUsageRecordsFn: async () => [],
      timerFactory: factory,
    }))

    await timers[0]!.fire()

    expect(sent.length).toBe(1)
    // May have tool-error section appended, so use toContain rather than toBe
    expect(sent[0]).toContain('No usage recorded yesterday.')
  })

  test('non-empty records sends summary with "Daily Usage Summary" header', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      loadUsageRecordsFn: async () => [makeRecord('chat123', 1000, 500)],
      timerFactory: factory,
    }))

    await timers[0]!.fire()

    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Daily Usage Summary')
    expect(sent[0]).toContain('chat123')
  })

  test('sendMessage failure is logged and swallowed — scheduler keeps running (re-fires next cycle)', async () => {
    let callCount = 0
    const sendMessage = mock(async (_text: string) => {
      callCount++
      throw new Error('telegram API down')
    })
    const { timers, factory } = makeTimerFactory()

    startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      timerFactory: factory,
    }))

    // First fire: sendMessage throws — should not propagate
    await timers[0]!.fire()
    expect(callCount).toBe(1)

    // A second 24h timer must still be registered (scheduler survived the error)
    expect(timers.length).toBe(2)

    // Second fire: sendMessage throws again — still swallowed
    await timers[1]!.fire()
    expect(callCount).toBe(2)
  })

  test('stop() cancels pending fire — sendMessage never called', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    const { stop } = startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      timerFactory: factory,
    }))

    // Cancel before firing
    stop()

    // Attempt to fire — cleared flag prevents execution
    await timers[0]!.fire()

    expect(sent.length).toBe(0)
  })

  test('stop() is idempotent — calling twice does not throw', () => {
    const { factory } = makeTimerFactory()

    const { stop } = startTelegramDailyDmScheduler(baseDeps({ timerFactory: factory }))

    expect(() => {
      stop()
      stop()
    }).not.toThrow()
  })

  test('loadUsageRecordsFn throws → sendMessage receives "Failed to load usage data" text', async () => {
    const sent: string[] = []
    const sendMessage = mock(async (text: string) => { sent.push(text) })
    const { timers, factory } = makeTimerFactory()

    startTelegramDailyDmScheduler(baseDeps({
      sendMessage,
      loadUsageRecordsFn: async () => { throw new Error('disk full') },
      timerFactory: factory,
    }))

    await timers[0]!.fire()

    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('Failed to load usage data')
    expect(sent[0]).toContain('disk full')
  })
})
