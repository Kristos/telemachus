/**
 * Phase 69 (TGCORE-05): Telegram session persistence bridge.
 *
 * Maps Telegram chat IDs to JSONL session IDs, persists turn deltas, and
 * hydrates ConversationManager on bot startup from existing JSONL files.
 *
 * Mirror of src/discord/session-bridge.ts — only the mapping filename,
 * sessionId prefix, parameter name, and log module tag differ.
 */
import { open, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { initSession, appendMessage, loadSession } from '../session/store.js'
import type { Message } from '../providers/types.js'
import type { MsgEntry } from '../session/types.js'
import type { ConversationManager } from '../discord/conversation.js'
import { log } from '../log/logger.js'

export const MAPPING_PATH = join(homedir(), '.telemachus', 'telegram-sessions.json')

/**
 * Load the chatId → sessionId mapping from disk.
 * Returns {} on ENOENT or JSON parse errors (first boot / corrupted file).
 */
export async function loadMapping(): Promise<Record<string, string>> {
  try {
    const text = await Bun.file(MAPPING_PATH).text()
    return JSON.parse(text) as Record<string, string>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    // JSON parse error or unexpected read error — return empty to avoid crashes
    log('warn', { module: 'telegram-session-bridge', error: err instanceof Error ? err.message : String(err) }, 'could not load mapping')
    return {}
  }
}

/**
 * Atomically write the mapping to disk.
 * Uses tmp-file + datasync + rename to prevent partial writes.
 */
export async function saveMapping(mapping: Record<string, string>): Promise<void> {
  await mkdir(join(homedir(), '.telemachus'), { recursive: true })
  const tmpPath = MAPPING_PATH + '.tmp'
  const fh = await open(tmpPath, 'w')
  await fh.writeFile(JSON.stringify(mapping, null, 2), 'utf8')
  await fh.datasync()
  await fh.close()
  await rename(tmpPath, MAPPING_PATH)
}

/**
 * Ensure a JSONL session exists for the given chatId.
 *
 * On first call for a chat: creates the session file and adds the
 * chatId to the persistent mapping. On subsequent calls: returns the
 * existing sessionId immediately (no I/O).
 */
export async function ensureSession(
  chatId: string,
  mapping: Record<string, string>,
  model: string,
): Promise<string> {
  if (mapping[chatId]) return mapping[chatId]

  const sessionId = `telegram-${chatId}`
  await initSession(sessionId, {
    id: sessionId,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    model,
  })

  mapping[chatId] = sessionId
  await saveMapping(mapping)
  return sessionId
}

/**
 * Append turn-delta messages to the session JSONL.
 *
 * `priorHistoryLength` is the number of messages that existed in result.messages
 * BEFORE the current turn (i.e., the slice index for new messages).
 * Only messages at index >= priorHistoryLength are appended.
 */
export async function persistTurnDelta(
  sessionId: string,
  priorHistoryLength: number,
  resultMessages: Message[],
): Promise<void> {
  const delta = resultMessages.slice(priorHistoryLength)
  for (const msg of delta) {
    await appendMessage(sessionId, msg)
  }
}

/**
 * Seed ConversationManager from existing JSONL sessions on startup.
 *
 * For each chat in the mapping, loads its JSONL file and replays
 * user and assistant text messages into the ConversationManager so the
 * bot can resume mid-conversation after a restart.
 *
 * Tool messages and messages with non-string content (ContentBlock arrays,
 * null) are skipped — ConversationManager only holds text turns.
 *
 * Per-chat errors are caught individually so a single corrupt session
 * file does not block other chats from loading.
 */
export async function hydrateConversations(
  conversations: ConversationManager,
  mapping: Record<string, string>,
): Promise<void> {
  for (const [chatId, sessionId] of Object.entries(mapping)) {
    try {
      const entries = await loadSession(sessionId)
      for (const entry of entries) {
        if (entry.type !== 'msg') continue
        const msgEntry = entry as MsgEntry
        const { message } = msgEntry
        if (message.role === 'user' && typeof message.content === 'string') {
          conversations.addUserMessage(chatId, message.content)
        } else if (message.role === 'assistant' && typeof message.content === 'string') {
          conversations.addAssistantMessage(chatId, message.content)
        }
        // Skip tool messages and non-string content (ContentBlock[], null)
      }
    } catch (err) {
      log('warn', { module: 'telegram-session-bridge', sessionId, telegramChatId: chatId, error: err instanceof Error ? err.message : String(err) }, 'could not hydrate chat')
    }
  }
}
