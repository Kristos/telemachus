/**
 * Phase 70 (TGAGENT-02 + TGAGENT-03): Streaming Telegram reply writer.
 *
 * Encapsulates the "post placeholder → edit every 1500ms with escaped preview
 * → on completion edit placeholder with chunks[0] + send the rest" state
 * machine behind a single factory. Plan 03's runner only sees:
 *   writer.start() / appendChunk / finalize / stop / replyError / getBuffer
 *
 * Key differences from src/discord/reply-writer.ts:
 *   1. EDIT_INTERVAL_MS 1200 → 1500  (Telegram has no 5/5s edit limit)
 *   2. STREAM_PREVIEW_MAX 1900 → 3800 (Telegram max is 4096)
 *   3. One-shot replySendTyping() only — no keep-alive loop needed for Telegram
 *   4. Placeholder identified by { chatId, messageId } + opts.editMessage
 *   5. Every outgoing string passes through escapeHtml() before it touches grammy
 */
import { chunkMessage } from './chunker.js'
import { escapeHtml } from './html-escape.js'
import { log } from '../log/logger.js'
import type { Message } from 'grammy/types'

/** 1.5s interval — under Telegram's 30 edits/minute per-message limit. */
const EDIT_INTERVAL_MS = 1500

/** Preview cap during streaming — leaves headroom within the 4096-char limit. */
const STREAM_PREVIEW_MAX = 3800

export interface TelegramReplyWriterOpts {
  chatId: string
  /** Send a new HTML-mode message; returns the grammy Message. */
  sendMessage: (text: string) => Promise<Message>
  /** Plain reply helper (HTML mode) — used as fallback when editMessage fails. */
  replySend: (text: string) => Promise<void>
  /** One-shot typing chat-action. */
  replySendTyping: () => Promise<void>
  /** Edit a message by id (HTML mode). */
  editMessage: (chatId: string, messageId: number, text: string) => Promise<void>
  /** Telegram user id surfaced to error logs. */
  userId: string
  /** Override for tests. Defaults to 1500ms. */
  editIntervalMs?: number
}

export interface ReplyWriter {
  start(): Promise<void>
  appendChunk(chunk: string): void
  /** Send the final response. Uses placeholder edit + follow-ups when possible. */
  finalize(text: string): Promise<void>
  /** Post an error message. Used by error-boundary catch path. */
  replyError(text: string): Promise<void>
  /** Stop the edit interval. Idempotent. */
  stop(): void
  /** Current stream buffer — raw, NOT escaped (used for tests and introspection). */
  getBuffer(): string
}

export function createTelegramReplyWriter(opts: TelegramReplyWriterOpts): ReplyWriter {
  const intervalMs = opts.editIntervalMs ?? EDIT_INTERVAL_MS

  let placeholder: { chatId: string; messageId: number } | null = null
  let streamBuffer = ''
  let lastEditLen = 0
  let stopped = false
  let editInterval: ReturnType<typeof setInterval> | null = null

  async function start(): Promise<void> {
    // One-shot typing indicator — errors swallowed
    opts.replySendTyping().catch(() => {})

    // Post editable placeholder; capture message_id for later edits
    try {
      const sent = await opts.sendMessage(escapeHtml('...'))
      placeholder = { chatId: opts.chatId, messageId: sent.message_id }
    } catch {
      // Placeholder send failed — finalize will fall back to plain replySend
      placeholder = null
    }

    // Start edit polling interval
    editInterval = setInterval(() => {
      if (stopped) return
      if (!placeholder) return
      if (streamBuffer.length <= lastEditLen) return
      lastEditLen = streamBuffer.length
      const raw =
        streamBuffer.length > STREAM_PREVIEW_MAX
          ? streamBuffer.slice(0, STREAM_PREVIEW_MAX) + '...'
          : streamBuffer
      // Pitfall 4: 400 / 429 / deleted message — swallow, keep going
      opts.editMessage(placeholder.chatId, placeholder.messageId, escapeHtml(raw)).catch(() => {})
    }, intervalMs)
    if (typeof editInterval === 'object' && editInterval !== null && 'unref' in editInterval) {
      (editInterval as { unref(): void }).unref()
    }
  }

  function appendChunk(chunk: string): void {
    streamBuffer += chunk
  }

  async function finalize(text: string): Promise<void> {
    const escaped = escapeHtml(text)
    const chunks = chunkMessage(escaped)
    if (placeholder) {
      // Edit placeholder with first chunk; fall back to replySend on error
      try {
        await opts.editMessage(placeholder.chatId, placeholder.messageId, chunks[0]!)
      } catch {
        try {
          await opts.replySend(chunks[0]!)
        } catch {
          /* swallow — best effort */
        }
      }
      // Send remaining chunks as follow-ups
      for (const c of chunks.slice(1)) {
        try {
          await opts.replySend(c)
        } catch {
          /* swallow */
        }
      }
    } else {
      // No placeholder — plain send for all chunks
      for (const c of chunks) {
        try {
          await opts.replySend(c)
        } catch {
          /* swallow */
        }
      }
    }
  }

  async function replyError(text: string): Promise<void> {
    const escaped = escapeHtml(text)
    if (placeholder) {
      try {
        await opts.editMessage(placeholder.chatId, placeholder.messageId, escaped)
        return
      } catch {
        /* fall through to replySend */
      }
    }
    try {
      await opts.replySend(escaped)
    } catch (err) {
      log(
        'error',
        {
          module: 'telegram-reply-writer',
          source: 'telegram',
          telegramUserId: opts.userId,
          telegramChatId: opts.chatId,
          error: err instanceof Error ? err.message : String(err),
        },
        'failed to send error reply',
      )
    }
  }

  function stop(): void {
    stopped = true
    if (editInterval !== null) {
      clearInterval(editInterval)
      editInterval = null
    }
  }

  function getBuffer(): string {
    return streamBuffer
  }

  return { start, appendChunk, finalize, replyError, stop, getBuffer }
}
