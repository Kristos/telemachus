/**
 * Phase 69 Plan 02: grammy bot core — lifecycle, owner allowlist, drain.
 *
 * Exports:
 *   - createOwnerGuard(ownerChatId)  — grammy middleware, TGCORE-01
 *   - runStartupSequence(opts)       — deleteWebhook before start, TGCORE-03
 *   - createShutdownHandler(opts)    — SIGTERM drain, TGCORE-04
 *   - startTelegramBot(opts)         — ties them all together
 *
 * Design mirrors src/discord/bot.ts lifecycle (process.on, await new Promise)
 * but is fully independent — no Discord imports.
 *
 * CRIT-01: bot.start() is NEVER awaited — it blocks forever. Invoke with .catch().
 */
import { Bot, type Context, type MiddlewareFn } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import { setDraining, hasPendingTurns, drainAllTurns } from './turn-queue.js'
import { log } from '../log/logger.js'
import type { TelegramConfig } from './config.js'

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Structural interface for the grammy Bot API — typed so tests can pass mocks
 * without importing grammy internals. Only the methods used by onStart wiring
 * are included.
 */
export interface TelegramBotApi {
  setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<unknown>
  sendMessage: (chatId: number, text: string, opts?: { parse_mode?: 'HTML' }) => Promise<unknown>
}

export interface TelegramBotOptions {
  telegramConfig: TelegramConfig
  /**
   * Optional handler for owner-allowed messages.
   * Defaults to stub reply '...' — Phase 70 injects real agent loop.
   */
  onMessage?: (ctx: Context) => Promise<void>
  /**
   * Phase 71 (TGNOTIF-01..03): Optional callback fired ONCE after the
   * grammy bot connects. Receives a sendMessage(text) helper bound to
   * the owner's chat — pre-configured with HTML parse mode — and the
   * bot.api handle (typed as TelegramBotApi) for setMyCommands registration.
   */
  onStart?: (sendMessage: (text: string) => Promise<void>, botApi: TelegramBotApi) => Promise<void>
}

// ── createOwnerGuard — TGCORE-01 ──────────────────────────────────────────────

/**
 * Returns a grammy middleware that silently drops updates where
 * ctx.from.id (as string) does not match ownerChatId.
 *
 * Silent drop: non-owners receive no reply — bot appears unresponsive.
 * Uses ctx.from.id (NOT ctx.chat.id) for the comparison per TGCORE-01.
 */
export function createOwnerGuard(ownerChatId: string): MiddlewareFn<Context> {
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    if (!ctx.from || String(ctx.from.id) !== ownerChatId) {
      // Silent drop — no reply, no log at info level
      log('debug', { module: 'telegram-bot', source: 'telegram', fromId: ctx.from?.id }, 'non-owner message dropped')
      return
    }
    await next()
  }
}

// ── runStartupSequence — TGCORE-03 ────────────────────────────────────────────

/**
 * Awaits deleteWebhook BEFORE invoking start().
 *
 * Prevents 409 Conflict errors: if a webhook was previously registered and a
 * prior long-polling session is still active, deleteWebhook clears it so
 * bot.start() can claim the update stream without conflict.
 *
 * Both deleteWebhook and start are passed as functions for testability.
 */
export async function runStartupSequence(opts: {
  deleteWebhook: (params: { drop_pending_updates: boolean }) => Promise<unknown>
  start: () => Promise<void> | void
}): Promise<void> {
  await opts.deleteWebhook({ drop_pending_updates: true })
  log('info', { module: 'telegram-bot', source: 'telegram' }, 'deleteWebhook called (drop_pending_updates=true)')
  await opts.start()
}

// ── createShutdownHandler — TGCORE-04 ─────────────────────────────────────────

/**
 * Returns an async shutdown function that:
 *   1. Calls queue.setDraining(true) — stops accepting new messages
 *   2. Awaits queue.drainAllTurns(drainTimeoutMs) IF hasPendingTurns()
 *   3. Calls bot.stop()
 *
 * queue is injected so tests can pass mock implementations.
 * drainTimeoutMs defaults to 30_000 (30 seconds).
 */
export function createShutdownHandler(opts: {
  bot: { stop: () => Promise<void> }
  queue: {
    setDraining: (b: boolean) => void
    hasPendingTurns: () => boolean
    drainAllTurns: (ms: number) => Promise<void>
  }
  drainTimeoutMs?: number
}): () => Promise<void> {
  const { bot, queue, drainTimeoutMs = 30_000 } = opts
  return async (): Promise<void> => {
    log('info', { module: 'telegram-bot', source: 'telegram' }, 'Telegram shutting down — draining in-flight turns')
    queue.setDraining(true)
    if (queue.hasPendingTurns()) {
      log('info', { module: 'telegram-bot', source: 'telegram', timeoutMs: drainTimeoutMs }, 'waiting for in-flight turns')
      await queue.drainAllTurns(drainTimeoutMs)
    }
    await bot.stop()
  }
}

// ── startTelegramBot ──────────────────────────────────────────────────────────

/**
 * Entry point for the Telegram bot.
 *
 * Lifecycle:
 *   1. Resolve token from environment variable
 *   2. Construct grammy Bot
 *   3. Register @grammyjs/auto-retry middleware on outgoing API calls
 *   4. Register owner guard middleware
 *   5. Register message handler (stub or injected onMessage)
 *   6. Run startup sequence: deleteWebhook → bot.start()
 *   7. Register SIGTERM/SIGINT handlers for graceful drain
 *   8. Block on Promise until shutdown completes
 *
 * CRIT-01: bot.start() is NEVER awaited — it blocks forever.
 */
export async function startTelegramBot(opts: TelegramBotOptions): Promise<void> {
  const { telegramConfig } = opts
  const tokenEnv = telegramConfig.tokenEnv
  const token = process.env[tokenEnv]

  if (!token) {
    throw new Error(
      `Telegram bot token not found. Set the ${tokenEnv} environment variable.`
    )
  }

  const ownerChatId = telegramConfig.ownerChatId
  const bot = new Bot(token)

  // Register auto-retry IMMEDIATELY after construction, BEFORE any handlers
  bot.api.config.use(autoRetry())

  // Owner allowlist — silently drops messages from non-owners
  bot.use(createOwnerGuard(ownerChatId))

  // Message handler: use injected onMessage or default stub reply
  const messageHandler = opts.onMessage
    ? opts.onMessage
    : async (ctx: Context): Promise<void> => {
        const chatId = String(ctx.chat!.id)
        log('debug', { module: 'telegram-bot', source: 'telegram', chatId }, 'stub reply')
        await ctx.reply('...')
      }

  bot.on('message:text', messageHandler)

  // Build the queue interface from the module-level functions
  const queue = { setDraining, hasPendingTurns, drainAllTurns }

  // Block the process until SIGTERM/SIGINT triggers shutdown
  await new Promise<void>((resolve) => {
    const shutdown = createShutdownHandler({
      bot,
      queue,
      drainTimeoutMs: 30_000,
    })

    const handleSignal = (): void => {
      void (async () => {
        await shutdown()
        resolve()
      })()
    }

    // Use process.once so tests don't accumulate handlers across multiple bot instances
    process.once('SIGTERM', handleSignal)
    process.once('SIGINT', handleSignal)

    // Run the startup sequence: deleteWebhook → bot.start()
    // bot.start() is NEVER awaited — it blocks forever (CRIT-01)
    const ownerChatNum = parseInt(ownerChatId, 10)
    const sendOwnerMessage = async (text: string): Promise<void> => {
      await bot.api.sendMessage(ownerChatNum, text, { parse_mode: 'HTML' })
    }

    void runStartupSequence({
      deleteWebhook: (params) => bot.api.deleteWebhook(params),
      start: () => {
        void bot.start({
          onStart: async () => {
            log('info', { module: 'telegram-bot', source: 'telegram' }, 'Telegram connected')
            if (opts.onStart) {
              try {
                await opts.onStart(sendOwnerMessage, bot.api as unknown as TelegramBotApi)
              } catch (err) {
                log('error', {
                  module: 'telegram-bot',
                  source: 'telegram',
                  error: err instanceof Error ? err.message : String(err),
                }, 'onStart callback failed')
              }
            }
          },
        }).catch((err: unknown) => {
          log('error', {
            module: 'telegram-bot',
            source: 'telegram',
            error: err instanceof Error ? err.message : String(err),
          }, 'bot.start() error')
          void handleSignal()
        })
        return Promise.resolve()
      },
    })
  })
}
