/**
 * Phase 65 (HYG-01): Extracted from runner.ts — streaming Discord reply
 * state machine. Encapsulates the typing indicator + editable placeholder
 * + per-interval stream edits + final chunked send sequence that the
 * runner previously inlined.
 *
 * Contract:
 *   - start() primes the typing indicator and posts the editable placeholder
 *     when replyEditable is available. Safe to call once per turn.
 *   - appendChunk(text) pushes streamed LLM tokens into the internal buffer;
 *     the 1.2s edit interval reads this buffer into the placeholder.
 *   - finalize(text) sends the definitive response — edits the placeholder
 *     with chunks[0] and posts follow-ups when chunk count > 1, or falls back
 *     to plain replySend when no placeholder exists.
 *   - stop() halts typing + clears the edit interval. Idempotent.
 *   - replyError(text) posts an error message via the same placeholder/send
 *     fallback path. Used by error-boundary's catch handler.
 *
 * The factory (createReplyWriter) returns a ReplyWriter object bound to the
 * current DiscordMessage + send helpers from message-intake normalization.
 */
import { chunkMessage } from './chunker.js'
import { TypingKeepAlive } from './typing.js'
import { log } from '../log/logger.js'
import type { DiscordMessage } from './message-intake.js'

/** 1.2s interval → max ~4.2 edits/5s, under Discord's 5/5s edit rate limit. */
const EDIT_INTERVAL_MS = 1200

/** Preview cap during streaming — leaves room for growth before the final edit. */
const STREAM_PREVIEW_MAX = 1900

export interface ReplyWriterOpts {
  msg: DiscordMessage
  replySend: (text: string) => Promise<void>
  replySendTyping: () => Promise<void>
  /** Discord IDs surfaced to error logs. */
  userId: string
  channelId: string
  /** Override for tests. Defaults to 1200ms. */
  editIntervalMs?: number
}

export interface ReplyWriter {
  start(): Promise<void>
  appendChunk(chunk: string): void
  /** Send the final response. Uses placeholder edit + follow-ups when possible. */
  finalize(text: string): Promise<void>
  /** Post an error message. Used by error-boundary catch path. */
  replyError(text: string): Promise<void>
  /** Stop typing + clear the edit interval. Idempotent. */
  stop(): void
  /** Current stream buffer (for tests and introspection). */
  getBuffer(): string
}

export function createReplyWriter(opts: ReplyWriterOpts): ReplyWriter {
  const intervalMs = opts.editIntervalMs ?? EDIT_INTERVAL_MS

  const typing = new TypingKeepAlive(() => {
    opts.replySendTyping().catch(() => {})
  })

  let placeholder: { edit: (text: string) => Promise<void> } | null = null
  let streamBuffer = ''
  let lastEditLen = 0
  let stopped = false
  let editInterval: ReturnType<typeof setInterval> | null = null

  async function start(): Promise<void> {
    typing.start()
    const replyEditable = opts.msg.replyEditable
    if (replyEditable) {
      placeholder = await replyEditable('...')
      // Placeholder replaces the typing indicator — stop it to avoid duplicate UI feedback.
      typing.stop()
    }
    editInterval = setInterval(async () => {
      if (stopped) return
      if (placeholder && streamBuffer.length > lastEditLen) {
        lastEditLen = streamBuffer.length
        try {
          const preview = streamBuffer.length > STREAM_PREVIEW_MAX
            ? streamBuffer.slice(0, STREAM_PREVIEW_MAX) + '...'
            : streamBuffer
          await placeholder.edit(preview)
        } catch {
          // Rate limit or message deleted — swallow silently, keep accumulating
        }
      }
    }, intervalMs)
    if (typeof editInterval === 'object' && editInterval !== null && 'unref' in editInterval) {
      (editInterval as { unref(): void }).unref()
    }
  }

  function appendChunk(chunk: string): void {
    streamBuffer += chunk
  }

  async function finalize(text: string): Promise<void> {
    const chunks = chunkMessage(text)
    if (placeholder) {
      // DISC-05: Edit placeholder with first chunk, send follow-ups for the rest
      try {
        await placeholder.edit(chunks[0]!)
      } catch {
        // Placeholder may have been deleted — fall back to regular send
        await opts.replySend(chunks[0]!)
      }
      for (const chunk of chunks.slice(1)) {
        await opts.replySend(chunk)
      }
    } else {
      for (const chunk of chunks) {
        await opts.replySend(chunk)
      }
    }
  }

  async function replyError(text: string): Promise<void> {
    // Mirrors the original runner.ts catch path: edit placeholder if possible,
    // else plain send, else log-and-swallow so the handler never crashes.
    if (placeholder) {
      try {
        await placeholder.edit(text)
      } catch {
        try { await opts.replySend(text) } catch {
          log('error', {
            module: 'discord-runner',
            source: 'discord',
            discordUserId: opts.userId,
            discordChannelId: opts.channelId,
            error: text,
          }, 'failed to edit error reply')
        }
      }
    } else {
      try {
        await opts.replySend(text)
      } catch {
        log('error', {
          module: 'discord-runner',
          source: 'discord',
          discordUserId: opts.userId,
          discordChannelId: opts.channelId,
          error: text,
        }, 'failed to send error reply')
      }
    }
  }

  function stop(): void {
    stopped = true
    if (editInterval !== null) {
      clearInterval(editInterval)
      editInterval = null
    }
    typing.stop()
  }

  function getBuffer(): string {
    return streamBuffer
  }

  return { start, appendChunk, finalize, replyError, stop, getBuffer }
}
