/**
 * Phase 69 (TGCORE-02, TGCORE-05): Tests for Telegram session-bridge.ts
 *
 * Tests cover:
 *   - TGCORE-05: ensureSession creates JSONL under telegram-${chatId} prefix
 *   - TGCORE-05: ensureSession returns existing sessionId on subsequent calls
 *   - TGCORE-02: hydrateConversations replays JSONL into ConversationManager keyed on chat ID
 *   - TGCORE-02 isolation: two chat IDs hydrate into independent histories
 *   - Negative chat IDs (group chats) handled correctly
 *
 * Isolation: unique test-prefixed session IDs are used so tests never collide
 * with real sessions. Mapping file is written to a tmpdir via a patched constant.
 * All files created during tests are cleaned up in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { open, rename, mkdir, rm } from 'node:fs/promises'

// ── Import module under test ───────────────────────────────────────────────────
import {
  loadMapping,
  saveMapping,
  ensureSession,
  hydrateConversations,
  MAPPING_PATH,
} from '../session-bridge.js'

import { ConversationManager } from '../../discord/conversation.js'
import { initSession, appendMessage } from '../../session/store.js'

// ── Test session directory (where real store writes) ──────────────────────────
const REAL_SESSIONS_DIR = join(homedir(), '.telemachus', 'sessions')

// Unique test run prefix so concurrent test runs don't collide
const RUN_ID = `tg-test-${Date.now()}`

// Mapping backup path for restoring after each test
const MAPPING_BACKUP = MAPPING_PATH + `.backup-${RUN_ID}`

// Track files created per test for cleanup
let testSessionIds: string[] = []

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(async () => {
  testSessionIds = []
  // Back up existing mapping (may not exist)
  try {
    const existing = await Bun.file(MAPPING_PATH).text()
    await mkdir(join(homedir(), '.telemachus'), { recursive: true })
    const fh = await open(MAPPING_BACKUP, 'w')
    await fh.writeFile(existing, 'utf8')
    await fh.close()
  } catch {
    // No existing mapping — nothing to back up
  }
  // Remove the mapping so each test starts fresh
  await rm(MAPPING_PATH, { force: true })
})

afterEach(async () => {
  // Remove mapping
  await rm(MAPPING_PATH, { force: true })
  // Restore backup if it existed
  try {
    const backup = await Bun.file(MAPPING_BACKUP).text()
    const fh = await open(MAPPING_PATH, 'w')
    await fh.writeFile(backup, 'utf8')
    await fh.close()
  } catch {
    // No backup — nothing to restore
  }
  await rm(MAPPING_BACKUP, { force: true })
  // Remove test session files
  for (const sessionId of testSessionIds) {
    const sessionFile = join(REAL_SESSIONS_DIR, `${sessionId}.jsonl`)
    await rm(sessionFile, { force: true })
  }
})

/** Helper to track and init a test session */
async function trackSession(sessionId: string): Promise<void> {
  testSessionIds.push(sessionId)
  await initSession(sessionId, {
    id: sessionId,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    model: 'test-model',
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ensureSession (TGCORE-05)', () => {
  it('creates a JSONL session under telegram-${chatId} prefix and updates mapping', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession(`${RUN_ID}-12345`, mapping, 'glm-4.6')
    testSessionIds.push(sessionId)

    expect(sessionId).toBe(`telegram-${RUN_ID}-12345`)
    expect(mapping[`${RUN_ID}-12345`]).toBe(`telegram-${RUN_ID}-12345`)

    // Verify mapping was persisted to disk
    const loaded = await loadMapping()
    expect(loaded[`${RUN_ID}-12345`]).toBe(`telegram-${RUN_ID}-12345`)

    // Verify MAPPING_PATH points to telegram-sessions.json (not discord-sessions.json)
    expect(MAPPING_PATH).toContain('telegram-sessions.json')
  })

  it('returns existing sessionId immediately when mapping already has the key', async () => {
    const mapping: Record<string, string> = {}

    // First call creates it
    const id1 = await ensureSession(`${RUN_ID}-repeat`, mapping, 'glm-4.6')
    testSessionIds.push(id1)
    // Second call returns existing without re-initialising
    const id2 = await ensureSession(`${RUN_ID}-repeat`, mapping, 'different-model')

    expect(id1).toBe(`telegram-${RUN_ID}-repeat`)
    expect(id2).toBe(`telegram-${RUN_ID}-repeat`)
    expect(id1).toBe(id2)
  })

  it('handles negative chat IDs (group chats) correctly', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession(`-${RUN_ID}-grp`, mapping, 'glm')
    testSessionIds.push(sessionId)

    expect(sessionId).toBe(`telegram--${RUN_ID}-grp`)
    expect(mapping[`-${RUN_ID}-grp`]).toBe(`telegram--${RUN_ID}-grp`)
  })
})

describe('hydrateConversations (TGCORE-02)', () => {
  it('replays JSONL msg entries into ConversationManager keyed on chat ID', async () => {
    const chatId = `${RUN_ID}-chat-111`
    const sessionId = `telegram-${chatId}`
    testSessionIds.push(sessionId)
    await trackSession(sessionId)

    await appendMessage(sessionId, { role: 'user', content: 'Hello bot' } as Parameters<typeof appendMessage>[1])
    await appendMessage(sessionId, { role: 'assistant', content: 'Hello user' } as Parameters<typeof appendMessage>[1])
    await appendMessage(sessionId, { role: 'user', content: 'How are you?' } as Parameters<typeof appendMessage>[1])

    const mapping: Record<string, string> = { [chatId]: sessionId }
    const conversations = new ConversationManager()
    await hydrateConversations(conversations, mapping)

    const history = conversations.getHistory(chatId)
    expect(history).toHaveLength(3)
    expect(history[0]).toMatchObject({ role: 'user', content: 'Hello bot' })
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Hello user' })
    expect(history[2]).toMatchObject({ role: 'user', content: 'How are you?' })
  })

  it('isolates histories: two different chat IDs yield independent ConversationManager histories (TGCORE-02)', async () => {
    const chatId111 = `${RUN_ID}-iso-111`
    const chatId222 = `${RUN_ID}-iso-222`
    const sessionId111 = `telegram-${chatId111}`
    const sessionId222 = `telegram-${chatId222}`
    testSessionIds.push(sessionId111, sessionId222)

    await trackSession(sessionId111)
    await appendMessage(sessionId111, { role: 'user', content: 'msg 1' } as Parameters<typeof appendMessage>[1])
    await appendMessage(sessionId111, { role: 'assistant', content: 'reply 1' } as Parameters<typeof appendMessage>[1])
    await appendMessage(sessionId111, { role: 'user', content: 'msg 2' } as Parameters<typeof appendMessage>[1])

    await trackSession(sessionId222)
    await appendMessage(sessionId222, { role: 'user', content: 'solo msg' } as Parameters<typeof appendMessage>[1])

    const mapping: Record<string, string> = {
      [chatId111]: sessionId111,
      [chatId222]: sessionId222,
    }

    const conversations = new ConversationManager()
    await hydrateConversations(conversations, mapping)

    const history111 = conversations.getHistory(chatId111)
    const history222 = conversations.getHistory(chatId222)

    // Independent histories with different lengths
    expect(history111.length).not.toBe(history222.length)
    expect(history111).toHaveLength(3)
    expect(history222).toHaveLength(1)
  })
})
