/**
 * Phase 70 (TGAGENT-03 enforcement): grammy Context → typed reply/edit
 * helpers. EVERY outgoing call routes through `{ parse_mode: 'HTML' }`
 * so the rest of the Telegram module can never accidentally send raw
 * text without HTML mode.
 *
 * Simpler than src/discord/message-intake.ts:
 *   - No thread routing (Telegram has no thread-creation path here)
 *   - No attachment fetching (Phase 70 is text-only; images deferred)
 *   - chatId is always String(ctx.chat.id); no DM/guild distinction
 */
import type { Context } from 'grammy'
import type { Message } from 'grammy/types'

export interface NormalizedTelegramIntake {
  /** String(ctx.chat.id) — conversation key */
  chatId: string
  /** ctx.message.text or ctx.message.caption (empty string if neither) */
  content: string
  /** String(ctx.from.id) — for audit log + budget keying */
  authorId: string
  /** ctx.message.message_id — id of the INCOMING user message */
  messageId: number
  /** Reply-and-discard helper (HTML mode). Returns void. */
  replySend: (text: string) => Promise<void>
  /** Send the typing chat-action one-shot. Returns void. */
  replySendTyping: () => Promise<void>
  /** Edit a previously-sent message by id (HTML mode). */
  editMessage: (chatId: string, messageId: number, text: string) => Promise<void>
  /** Send a new message and return the grammy Message so callers can capture message_id. */
  sendMessage: (text: string) => Promise<Message>
}

export function normalizeIncomingMessage(ctx: Context): NormalizedTelegramIntake {
  const chatId = String(ctx.chat!.id)
  const content = ctx.message?.text ?? ctx.message?.caption ?? ''
  const authorId = String(ctx.from!.id)
  const messageId = ctx.message!.message_id

  const replySend = async (text: string): Promise<void> => {
    await ctx.reply(text, { parse_mode: 'HTML' })
  }
  const replySendTyping = async (): Promise<void> => {
    await ctx.replyWithChatAction('typing')
  }
  const editMessage = async (cid: string, mid: number, text: string): Promise<void> => {
    await ctx.api.editMessageText(cid, mid, text, { parse_mode: 'HTML' })
  }
  const sendMessage = async (text: string): Promise<Message> => {
    return ctx.reply(text, { parse_mode: 'HTML' })
  }

  return {
    chatId,
    content,
    authorId,
    messageId,
    replySend,
    replySendTyping,
    editMessage,
    sendMessage,
  }
}
