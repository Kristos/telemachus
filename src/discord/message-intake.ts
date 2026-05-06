/**
 * Phase 65 (HYG-01): Extracted from runner.ts — Discord gateway message
 * intake. Handles attachment fetching (images + text), multimodal content
 * enrichment, and the guild → thread routing.
 *
 * Responsibilities:
 *   - DiscordAttachment + DiscordMessage types (external contract preserved)
 *   - fetchAttachment: download image/text attachment, return base64/text/null
 *   - normalizeIncomingMessage: route guild @mentions to threads, compute
 *     target channel + send helpers + enriched content + image blocks
 *
 * Command interception (isCommand / handleCommand) stays in runner.ts because
 * it needs the full DiscordRunnerDeps shape. normalizeIncomingMessage is
 * called AFTER the command short-circuit in the orchestrator.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface DiscordAttachment {
  url: string
  name: string
  contentType: string | null
  size: number
}

export interface DiscordMessage {
  channelId: string
  content: string
  authorId: string
  /** File/image attachments on the message */
  attachments?: DiscordAttachment[]
  /** Send a reply in the channel/thread */
  reply: (text: string) => Promise<void>
  /** Show typing indicator */
  sendTyping: () => Promise<void>
  /** Whether this is a guild channel message (not DM, not thread) */
  isGuild: boolean
  /** Whether this message is inside an existing thread */
  isThread?: boolean
  /** Create a thread from this message (guild channel only). Returns thread channelId. */
  createThread?: (name: string) => Promise<{
    id: string
    send: (text: string) => Promise<void>
    sendTyping: () => Promise<void>
  }>
  /**
   * Phase 32 (DISC-05): Send a reply and return an editable message handle.
   * Used for streaming — the bot posts a placeholder then edits it as tokens arrive.
   */
  replyEditable?: (text: string) => Promise<{ edit: (text: string) => Promise<void> }>
}

// ─── Attachment handling ──────────────────────────────────────────────────

/** Image MIME types that LLM providers accept for vision */
export const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

/** Max file size for text attachments (100KB) */
export const MAX_TEXT_SIZE = 100_000

/**
 * Download a Discord attachment and return it as a base64 string (images)
 * or UTF-8 text (text files). Returns null on failure.
 */
export async function fetchAttachment(
  att: DiscordAttachment,
): Promise<
  | { type: 'image'; mediaType: string; base64: string }
  | { type: 'text'; name: string; content: string }
  | null
> {
  try {
    const res = await fetch(att.url)
    if (!res.ok) return null

    if (att.contentType && IMAGE_MIME_TYPES.has(att.contentType)) {
      const buf = await res.arrayBuffer()
      const base64 = Buffer.from(buf).toString('base64')
      return { type: 'image', mediaType: att.contentType, base64 }
    }

    // Text-like files (code, config, logs, markdown, etc.)
    if (att.size <= MAX_TEXT_SIZE) {
      const text = await res.text()
      return { type: 'text', name: att.name, content: text }
    }

    // Too large — skip with note
    return { type: 'text', name: att.name, content: `[File too large: ${att.name} (${Math.round(att.size / 1024)}KB)]` }
  } catch {
    return null
  }
}

// ─── Message normalization ────────────────────────────────────────────────

export type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; mediaType: string; data: string }
}

/**
 * Result of normalizing an incoming Discord message — contains the target
 * channel to route replies to (thread for guild messages), reply helpers,
 * enriched text content (with text attachment bodies appended), and
 * any image blocks for multimodal LLM calls.
 */
export interface NormalizedMessage {
  targetChannelId: string
  replySend: (text: string) => Promise<void>
  replySendTyping: () => Promise<void>
  enrichedContent: string
  imageBlocks: ImageBlock[]
}

/**
 * Normalize an incoming Discord message for downstream turn execution.
 *
 *   - Guild @mentions (msg.isGuild && msg.createThread): create a thread,
 *     route replies to the thread.
 *   - DMs / thread messages: pass through unchanged.
 *   - Attachments: download all, enrich text content with text files,
 *     collect image blocks for multimodal messaging.
 */
export async function normalizeIncomingMessage(
  msg: DiscordMessage,
): Promise<NormalizedMessage> {
  // For guild messages, create a thread and route there instead of the channel
  let targetChannelId = msg.channelId
  let replySend = msg.reply
  let replySendTyping = msg.sendTyping

  if (msg.isGuild && msg.createThread) {
    const threadName = msg.content.slice(0, 50).replace(/\n/g, ' ') || 'Agent conversation'
    const thread = await msg.createThread(threadName)
    targetChannelId = thread.id
    replySend = thread.send
    replySendTyping = thread.sendTyping
  }

  // Process attachments: download images + text files
  let enrichedContent = msg.content
  const imageBlocks: ImageBlock[] = []

  if (msg.attachments && msg.attachments.length > 0) {
    const results = await Promise.all(msg.attachments.map(fetchAttachment))
    for (const r of results) {
      if (!r) continue
      if (r.type === 'image') {
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', mediaType: r.mediaType, data: r.base64 },
        })
      } else if (r.type === 'text') {
        enrichedContent += `\n\n--- ${r.name} ---\n${r.content}`
      }
    }
  }

  return { targetChannelId, replySend, replySendTyping, enrichedContent, imageBlocks }
}
