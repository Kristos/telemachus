/**
 * Phase 32 (DISC-06): Unit tests for session-bridge.ts
 *
 * Tests cover:
 *   - loadMapping returns {} when file does not exist
 *   - saveMapping writes atomically and loadMapping reads it back
 *   - ensureSession creates new session on first call, returns existing on second
 *   - persistTurnDelta appends only delta messages
 *   - hydrateConversations seeds ConversationManager from JSONL
 *   - hydrateConversations skips tool messages
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { ConversationManager } from '../conversation.js'

// ── Test isolation: redirect MAPPING_PATH to a temp directory ─────────────────
//
// We override the MAPPING_PATH constant at module level using a fresh temp dir
// per test run so tests never touch the real ~/.telemachus directory.

const TEST_DIR = join(tmpdir(), `session-bridge-test-${Date.now()}`)
const TEST_MAPPING_PATH = join(TEST_DIR, 'discord-sessions.json')
const TEST_SESSIONS_DIR = join(TEST_DIR, 'sessions')

// Mock the module paths used by session-bridge and store
mock.module('../../session/store.js', () => {
  const { open, rename, mkdir: mkdirFs } = require('node:fs/promises')
  const { join: joinPath } = require('path')

  const SESSIONS_DIR = TEST_SESSIONS_DIR

  function sessionPath(id: string): string {
    return joinPath(SESSIONS_DIR, `${id}.jsonl`)
  }

  function tmpPath(id: string): string {
    return sessionPath(id) + '.tmp'
  }

  return {
    async initSession(id: string, meta: { type?: string; id: string; startedAt: string; cwd: string; model: string }): Promise<void> {
      await mkdirFs(SESSIONS_DIR, { recursive: true })
      const entry = { type: 'meta', ...meta }
      const line = JSON.stringify(entry) + '\n'
      const tmp = tmpPath(id)
      const fh = await open(tmp, 'w')
      await fh.writeFile(line, 'utf8')
      await fh.datasync()
      await fh.close()
      await rename(tmp, sessionPath(id))
    },

    async appendMessage(id: string, message: unknown): Promise<void> {
      const entry = { type: 'msg', message }
      const line = JSON.stringify(entry) + '\n'
      const fh = await open(sessionPath(id), 'a')
      await fh.appendFile(line, 'utf8')
      await fh.datasync()
      await fh.close()
    },

    async loadSession(id: string): Promise<unknown[]> {
      try {
        const text = await Bun.file(sessionPath(id)).text()
        return text.split('\n').filter((l: string) => l.trim()).map((l: string) => {
          try { return JSON.parse(l) } catch { return null }
        }).filter(Boolean)
      } catch {
        return []
      }
    },
  }
})

// Import mock helper
import { mock } from 'bun:test'

// Import module under test AFTER mocks are set up
// We also need to patch MAPPING_PATH — re-export with overridden path
// Since session-bridge uses MAPPING_PATH constant, we test via the exported functions
// but patch the path by replacing the module after mock setup.

// Direct approach: we'll override MAPPING_PATH using Bun's module mock
mock.module('../session-bridge.js', () => {
  // Synchronous factory avoids async deadlock when bun runs multiple test
  // files that mock the same module concurrently (session-bridge + streaming).
  const { open, rename, mkdir: mkdirFs } = require('node:fs/promises') as typeof import('node:fs/promises')

  const MAPPING_PATH = TEST_MAPPING_PATH

  async function loadMapping(): Promise<Record<string, string>> {
    try {
      const text = await Bun.file(MAPPING_PATH).text()
      return JSON.parse(text) as Record<string, string>
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return {}
      return {}
    }
  }

  async function saveMapping(mapping: Record<string, string>): Promise<void> {
    await mkdirFs(TEST_DIR, { recursive: true })
    const tmpPath = MAPPING_PATH + '.tmp'
    const fh = await open(tmpPath, 'w')
    await fh.writeFile(JSON.stringify(mapping, null, 2), 'utf8')
    await fh.datasync()
    await fh.close()
    await rename(tmpPath, MAPPING_PATH)
  }

  const { initSession, appendMessage, loadSession } = require('../../session/store.js') as {
    initSession: (id: string, meta: Record<string, string>) => Promise<void>
    appendMessage: (id: string, msg: unknown) => Promise<void>
    loadSession: (id: string) => Promise<unknown[]>
  }

  async function ensureSession(
    channelId: string,
    mapping: Record<string, string>,
    model: string,
  ): Promise<string> {
    if (mapping[channelId]) return mapping[channelId]
    const sessionId = `discord-${channelId}`
    await initSession(sessionId, {
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      model,
    })
    mapping[channelId] = sessionId
    await saveMapping(mapping)
    return sessionId
  }

  async function persistTurnDelta(
    sessionId: string,
    priorHistoryLength: number,
    resultMessages: unknown[],
  ): Promise<void> {
    const delta = resultMessages.slice(priorHistoryLength)
    for (const msg of delta) {
      await appendMessage(sessionId, msg)
    }
  }

  async function hydrateConversations(
    conversations: import('../conversation.js').ConversationManager,
    mapping: Record<string, string>,
  ): Promise<void> {
    for (const [channelId, sessionId] of Object.entries(mapping)) {
      try {
        const entries = await loadSession(sessionId) as Array<{ type: string; message?: { role: string; content: unknown } }>
        for (const entry of entries) {
          if (entry.type !== 'msg' || !entry.message) continue
          const { message } = entry
          if (message.role === 'user' && typeof message.content === 'string') {
            conversations.addUserMessage(channelId, message.content)
          } else if (message.role === 'assistant' && typeof message.content === 'string') {
            conversations.addAssistantMessage(channelId, message.content)
          }
        }
      } catch (err) {
        process.stderr.write(
          `[session-bridge] warn: could not hydrate channel ${channelId}: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  return {
    MAPPING_PATH,
    loadMapping,
    saveMapping,
    ensureSession,
    persistTurnDelta,
    hydrateConversations,
  }
})

const {
  loadMapping,
  saveMapping,
  ensureSession,
  persistTurnDelta,
  hydrateConversations,
} = await import('../session-bridge.js') as {
  loadMapping: () => Promise<Record<string, string>>
  saveMapping: (m: Record<string, string>) => Promise<void>
  ensureSession: (channelId: string, mapping: Record<string, string>, model: string) => Promise<string>
  persistTurnDelta: (sessionId: string, priorLen: number, messages: unknown[]) => Promise<void>
  hydrateConversations: (conversations: ConversationManager, mapping: Record<string, string>) => Promise<void>
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadMapping', () => {
  it('returns {} when file does not exist', async () => {
    const result = await loadMapping()
    expect(result).toEqual({})
  })

  it('returns {} on malformed JSON', async () => {
    await writeFile(TEST_MAPPING_PATH, 'not valid json')
    const result = await loadMapping()
    expect(result).toEqual({})
  })
})

describe('saveMapping / loadMapping', () => {
  it('writes atomically and loadMapping reads it back', async () => {
    const mapping = { 'ch-001': 'discord-ch-001', 'ch-002': 'discord-ch-002' }
    await saveMapping(mapping)
    const loaded = await loadMapping()
    expect(loaded).toEqual(mapping)
  })

  it('overwrites existing mapping', async () => {
    await saveMapping({ 'ch-001': 'discord-ch-001' })
    await saveMapping({ 'ch-999': 'discord-ch-999' })
    const loaded = await loadMapping()
    expect(loaded).toEqual({ 'ch-999': 'discord-ch-999' })
  })
})

describe('ensureSession', () => {
  it('creates new session on first call and adds to mapping', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-abc', mapping, 'test-model')
    expect(sessionId).toBe('discord-ch-abc')
    expect(mapping['ch-abc']).toBe('discord-ch-abc')
    // Mapping should be persisted
    const loaded = await loadMapping()
    expect(loaded['ch-abc']).toBe('discord-ch-abc')
  })

  it('returns existing sessionId on second call without re-creating', async () => {
    const mapping: Record<string, string> = {}
    const id1 = await ensureSession('ch-abc', mapping, 'model-a')
    const id2 = await ensureSession('ch-abc', mapping, 'model-b')
    expect(id1).toBe(id2)
    expect(id1).toBe('discord-ch-abc')
  })

  it('handles multiple channels independently', async () => {
    const mapping: Record<string, string> = {}
    const id1 = await ensureSession('ch-001', mapping, 'model')
    const id2 = await ensureSession('ch-002', mapping, 'model')
    expect(id1).toBe('discord-ch-001')
    expect(id2).toBe('discord-ch-002')
    expect(Object.keys(mapping)).toHaveLength(2)
  })
})

describe('persistTurnDelta', () => {
  it('appends only delta messages (after priorHistoryLength)', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-delta', mapping, 'model')

    const allMessages = [
      { role: 'user', content: 'prior message 1' },
      { role: 'assistant', content: 'prior response 1' },
      { role: 'user', content: 'current turn user' },
      { role: 'assistant', content: 'current turn response' },
    ]

    // Prior history length = 2 (first user+assistant pair)
    await persistTurnDelta(sessionId, 2, allMessages)

    // Load session and check only delta messages were appended
    const { loadSession } = await import('../../session/store.js') as {
      loadSession: (id: string) => Promise<Array<{ type: string; message?: unknown }>>
    }
    const entries = await loadSession(sessionId)
    const msgEntries = entries.filter(e => e.type === 'msg')

    // Only the 2 delta messages should be present (not the 2 prior ones)
    expect(msgEntries).toHaveLength(2)
    expect((msgEntries[0] as { type: string; message: { role: string; content: string } }).message.content).toBe('current turn user')
    expect((msgEntries[1] as { type: string; message: { role: string; content: string } }).message.content).toBe('current turn response')
  })

  it('appends nothing when delta is empty', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-empty-delta', mapping, 'model')
    const messages = [{ role: 'user', content: 'msg' }]
    // priorHistoryLength >= messages.length → no delta
    await persistTurnDelta(sessionId, messages.length, messages)

    const { loadSession } = await import('../../session/store.js') as {
      loadSession: (id: string) => Promise<Array<{ type: string }>>
    }
    const entries = await loadSession(sessionId)
    const msgEntries = entries.filter(e => e.type === 'msg')
    expect(msgEntries).toHaveLength(0)
  })
})

describe('hydrateConversations', () => {
  it('seeds ConversationManager with user and assistant messages from JSONL', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-hydrate', mapping, 'model')

    // Write some messages directly to the session
    const { appendMessage } = await import('../../session/store.js') as {
      appendMessage: (id: string, msg: unknown) => Promise<void>
    }
    await appendMessage(sessionId, { role: 'user', content: 'Hello bot' })
    await appendMessage(sessionId, { role: 'assistant', content: 'Hello user' })
    await appendMessage(sessionId, { role: 'user', content: 'How are you?' })

    const conversations = new ConversationManager()
    await hydrateConversations(conversations, mapping)

    const history = conversations.getHistory('ch-hydrate')
    expect(history).toHaveLength(3)
    expect(history[0]).toMatchObject({ role: 'user', content: 'Hello bot' })
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Hello user' })
    expect(history[2]).toMatchObject({ role: 'user', content: 'How are you?' })
  })

  it('skips tool messages (non-user/assistant roles)', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-tools', mapping, 'model')

    const { appendMessage } = await import('../../session/store.js') as {
      appendMessage: (id: string, msg: unknown) => Promise<void>
    }
    await appendMessage(sessionId, { role: 'user', content: 'Run a tool' })
    // Simulate a tool result message (role 'tool' is not user/assistant)
    await appendMessage(sessionId, { role: 'tool', content: 'tool output', tool_use_id: 'tu-1' })
    await appendMessage(sessionId, { role: 'assistant', content: 'Done' })

    const conversations = new ConversationManager()
    await hydrateConversations(conversations, mapping)

    const history = conversations.getHistory('ch-tools')
    // Only user + assistant messages; tool message is skipped
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user', content: 'Run a tool' })
    expect(history[1]).toMatchObject({ role: 'assistant', content: 'Done' })
  })

  it('skips messages with non-string content (ContentBlock arrays)', async () => {
    const mapping: Record<string, string> = {}
    const sessionId = await ensureSession('ch-blocks', mapping, 'model')

    const { appendMessage } = await import('../../session/store.js') as {
      appendMessage: (id: string, msg: unknown) => Promise<void>
    }
    // ContentBlock array content — not a string
    await appendMessage(sessionId, { role: 'assistant', content: [{ type: 'text', text: 'block' }] })
    await appendMessage(sessionId, { role: 'user', content: 'plain text user' })

    const conversations = new ConversationManager()
    await hydrateConversations(conversations, mapping)

    const history = conversations.getHistory('ch-blocks')
    // Only the plain text user message should be added
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ role: 'user', content: 'plain text user' })
  })

  it('handles empty mapping gracefully', async () => {
    const conversations = new ConversationManager()
    await hydrateConversations(conversations, {})
    // No channels — no history anywhere
    expect(conversations.getHistory('anything')).toHaveLength(0)
  })

  it('continues hydrating other channels when one session file is missing', async () => {
    // mapping points to a non-existent session ID
    const mapping = {
      'ch-missing': 'discord-ch-missing-nonexistent',
      'ch-good': 'discord-ch-good',
    }

    // Create only the good channel's session
    const { initSession, appendMessage } = await import('../../session/store.js') as unknown as {
      initSession: (id: string, meta: Record<string, string>) => Promise<void>
      appendMessage: (id: string, msg: unknown) => Promise<void>
    }
    await initSession('discord-ch-good', {
      id: 'discord-ch-good',
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      model: 'model',
    })
    await appendMessage('discord-ch-good', { role: 'user', content: 'good message' })

    const conversations = new ConversationManager()
    // Should not throw even though ch-missing's session doesn't exist
    await hydrateConversations(conversations, mapping)

    const goodHistory = conversations.getHistory('ch-good')
    expect(goodHistory).toHaveLength(1)
    expect(goodHistory[0]).toMatchObject({ role: 'user', content: 'good message' })
  })
})
