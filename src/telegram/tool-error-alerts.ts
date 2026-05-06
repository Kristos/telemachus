/**
 * Phase 71 (TGNOTIF-03): Telegram tool-error alert watcher. Mirrors
 * discord/tool-error-alerts.ts but uses a chatId-captured
 * sendMessage(text) helper instead of sendDm(userId, text).
 *
 * Periodic tick reads the OBS-02 rolling metric (ratePerTool over
 * perToolWindowMs) and sends one sendMessage(text) per tool whose
 * count meets perToolThreshold, subject to per-tool cooldown.
 */
import { log } from '../log/logger.js'
import { ratePerTool, getRecentErrors } from '../security/tool-error-metrics.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolErrorAlertConfig {
  /** N failures of same tool in window → alert (default 3). Set 0 to disable. */
  perToolThreshold?: number
  /** Window for per-tool count (default 15 * 60_000 = 15m). */
  perToolWindowMs?: number
  /** Cooldown between alerts per tool (default 30 * 60_000 = 30m). */
  cooldownMs?: number
  /** Tick interval in ms (default 60_000 = 60s). */
  tickIntervalMs?: number
}

export interface TelegramToolErrorAlertDeps {
  /** Sends a message to the owner's chat. chatId is captured at construction. */
  sendMessage: (text: string) => Promise<void>
  config?: ToolErrorAlertConfig
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number
  /**
   * Injectable ticker for deterministic tests. When absent, uses setInterval.
   * Tests pass a stub factory that captures the callback so they can fire
   * ticks manually and await the async work.
   */
  tickerFactory?: (cb: () => Promise<void>, ms: number) => { clear: () => void }
  /** Injectable ratePerTool for testing — avoids mock.module(). */
  ratePerToolFn?: (windowMs: number, now?: () => number) => Map<string, number>
  /** Injectable getRecentErrors for testing — avoids mock.module(). */
  getRecentErrorsFn?: (windowMs: number, limit: number, now?: () => number) => ReturnType<typeof getRecentErrors>
}

export interface TelegramToolErrorAlertWatcher {
  start: () => void
  stop: () => void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 15 * 60_000
const DEFAULT_COOLDOWN_MS = 30 * 60_000
const DEFAULT_TICK_MS = 60_000

// ---------------------------------------------------------------------------
// createTelegramToolErrorAlertWatcher
// ---------------------------------------------------------------------------

export function createTelegramToolErrorAlertWatcher(
  deps: TelegramToolErrorAlertDeps,
): TelegramToolErrorAlertWatcher {
  const threshold = deps.config?.perToolThreshold ?? DEFAULT_THRESHOLD
  const windowMs = deps.config?.perToolWindowMs ?? DEFAULT_WINDOW_MS
  const cooldownMs = deps.config?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const tickMs = deps.config?.tickIntervalMs ?? DEFAULT_TICK_MS
  const nowFn = deps.now ?? Date.now
  const rateFn = deps.ratePerToolFn ?? ratePerTool
  const recentFn = deps.getRecentErrorsFn ?? getRecentErrors

  // Closure-scoped cooldown — {toolName → lastAlertEpochMs}. Independent
  // per-watcher so tests don't share state.
  const cooldown = new Map<string, number>()

  let handle: { clear: () => void } | null = null

  const tick = async (): Promise<void> => {
    if (threshold <= 0) return // disabled
    try {
      const now = nowFn()
      const counts = rateFn(windowMs, nowFn)
      for (const [tool, count] of counts.entries()) {
        if (count < threshold) continue
        const last = cooldown.get(tool)
        if (last !== undefined && now - last < cooldownMs) continue

        const recent = recentFn(windowMs, 50, nowFn).find((s) => s.tool === tool)
        const errorClass = recent?.errorClass ?? 'Unknown'
        const errorMessage = recent?.errorMessage ?? ''
        const windowMinutes = Math.round(windowMs / 60_000)
        const text =
          `⚠ Tool failure alert: \`${tool}\` failed ${count} times in the last ${windowMinutes}m.\n` +
          `Last error: ${errorClass} — ${errorMessage}\n` +
          `Check audit log for details.`

        try {
          await deps.sendMessage(text)
        } catch (err) {
          log(
            'error',
            {
              module: 'telegram-tool-error-alerts',
              source: 'telegram',
              tool,
              error: err instanceof Error ? err.message : String(err),
            },
            'tool-error alert failed',
          )
        }
        cooldown.set(tool, now)
      }
    } catch (err) {
      log(
        'error',
        {
          module: 'telegram-tool-error-alerts',
          source: 'telegram',
          error: err instanceof Error ? err.message : String(err),
        },
        'tool-error watcher tick crashed',
      )
    }
  }

  const start = (): void => {
    if (handle !== null) return // idempotent
    if (deps.tickerFactory) {
      handle = deps.tickerFactory(tick, tickMs)
    } else {
      const intervalId = setInterval(() => { void tick() }, tickMs)
      handle = { clear: () => clearInterval(intervalId) }
    }
  }

  const stop = (): void => {
    if (handle !== null) {
      handle.clear()
      handle = null
    }
  }

  return { start, stop }
}
