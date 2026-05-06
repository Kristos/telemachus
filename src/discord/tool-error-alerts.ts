/**
 * Phase 63 (OBS-03): Tool-error DM alert watcher.
 *
 * Runs a periodic tick that:
 *   1. Reads the OBS-02 rolling metric (ratePerTool over perToolWindowMs)
 *   2. For each tool whose count meets perToolThreshold AND whose cooldown
 *      has expired, sends one DM to the owner describing the tool, count,
 *      and last-seen error class + message
 *   3. Updates the per-tool cooldown Map so subsequent ticks within cooldown
 *      do not re-alert
 *
 * Factory-returned watcher — cooldown Map is closure-scoped so multiple
 * test instances don't share state. sendDm failures are logged and
 * swallowed so the watcher survives transient Discord API errors.
 *
 * Wired into the bot at src/discord/index.ts onReady alongside the daily-dm
 * scheduler; lifecycle stops via combineStoppables.
 */
import { log } from '../log/logger.js'
import { ratePerTool, getRecentErrors } from '../security/tool-error-metrics.js'
import type { DiscordConfig } from './config.js'

export interface ToolErrorAlertConfig {
  /** N failures of same tool in window → DM (default 3). Set 0 to disable. */
  perToolThreshold?: number
  /** Window for per-tool count (default 15 * 60_000 = 15m). */
  perToolWindowMs?: number
  /** Cooldown between DMs per tool (default 30 * 60_000 = 30m). */
  cooldownMs?: number
  /** Tick interval in ms (default 60_000 = 60s). */
  tickIntervalMs?: number
}

export interface ToolErrorAlertDeps {
  sendDm: (userId: string, text: string) => Promise<void>
  ownerId: string
  config?: DiscordConfig['toolErrorAlerts']
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number
  /**
   * Injectable ticker for deterministic tests. When absent, uses setInterval
   * under the hood. Tests pass a stub factory that captures the async
   * callback so they can fire ticks manually AND await the async work.
   */
  tickerFactory?: (cb: () => Promise<void>, ms: number) => { clear: () => void }
}

export interface ToolErrorAlertWatcher {
  start: () => void
  stop: () => void
}

const DEFAULT_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 15 * 60_000
const DEFAULT_COOLDOWN_MS = 30 * 60_000
const DEFAULT_TICK_MS = 60_000

export function createToolErrorAlertWatcher(deps: ToolErrorAlertDeps): ToolErrorAlertWatcher {
  const threshold = deps.config?.perToolThreshold ?? DEFAULT_THRESHOLD
  const windowMs = deps.config?.perToolWindowMs ?? DEFAULT_WINDOW_MS
  const cooldownMs = deps.config?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const tickMs = deps.config?.tickIntervalMs ?? DEFAULT_TICK_MS
  const nowFn = deps.now ?? Date.now

  // Closure-scoped cooldown — {toolName → lastAlertEpochMs}. Independent
  // per-watcher so tests don't share state.
  const cooldown = new Map<string, number>()

  let handle: { clear: () => void } | null = null

  const tick = async (): Promise<void> => {
    if (threshold <= 0) return // disabled
    try {
      const now = nowFn()
      const counts = ratePerTool(windowMs, nowFn)
      for (const [tool, count] of counts.entries()) {
        if (count < threshold) continue
        const last = cooldown.get(tool)
        // Cooldown only applies after a prior alert; first-time alerts fire
        // immediately regardless of `now`'s absolute value (important for
        // deterministic tests that use low epoch values).
        if (last !== undefined && now - last < cooldownMs) continue

        // Lookup most-recent sample for this tool within window for the
        // "Last error" fields in the DM.
        const recent = getRecentErrors(windowMs, 50, nowFn).find((s) => s.tool === tool)
        const errorClass = recent?.errorClass ?? 'Unknown'
        const errorMessage = recent?.errorMessage ?? ''
        const windowMinutes = Math.round(windowMs / 60_000)
        const text =
          `⚠ Tool failure alert: \`${tool}\` failed ${count} times in the last ${windowMinutes}m.\n` +
          `Last error: ${errorClass} — ${errorMessage}\n` +
          `Check audit log for details.`

        try {
          await deps.sendDm(deps.ownerId, text)
        } catch (err) {
          log(
            'error',
            {
              module: 'tool-error-alerts',
              source: 'discord',
              userId: deps.ownerId,
              tool,
              error: err instanceof Error ? err.message : String(err),
            },
            'tool-error DM failed',
          )
        }
        cooldown.set(tool, now)
      }
    } catch (err) {
      // Defensive: ring-buffer computation should never throw, but we do not
      // want a watcher tick to bring down the bot if it does.
      log(
        'error',
        {
          module: 'tool-error-alerts',
          source: 'discord',
          error: err instanceof Error ? err.message : String(err),
        },
        'tool-error watcher tick crashed',
      )
    }
  }

  const start = (): void => {
    if (handle !== null) return // idempotent — already started
    if (deps.tickerFactory) {
      // Test factory receives the awaitable callback directly so fire() can
      // `await` it in tests.
      handle = deps.tickerFactory(tick, tickMs)
    } else {
      const intervalId = setInterval(() => {
        void tick()
      }, tickMs)
      if (typeof intervalId === 'object' && intervalId !== null && 'unref' in intervalId) {
        (intervalId as { unref(): void }).unref()
      }
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
