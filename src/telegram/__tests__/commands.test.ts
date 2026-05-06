/**
 * Phase 71 Plan 01 (TGCMDS-01..07): Telegram slash command tests.
 *
 * Wave 0 (RED): Tests written BEFORE commands.ts exists.
 * Wave 1 (GREEN): All tests pass after commands.ts is implemented.
 *
 * Test layout:
 *   - describe('isTelegramCommand') — 12+ assertions
 *   - describe('handleTelegramCommand /cost') — 2 cases
 *   - describe('handleTelegramCommand /context') — 2 cases
 *   - describe('handleTelegramCommand /compact') — 2 cases
 *   - describe('handleTelegramCommand /model') — 4 cases
 *   - describe('handleTelegramCommand /clear') — 1 case
 *   - describe('handleTelegramCommand /orchestrate') — 1 case
 *   - describe('handleTelegramCommand /tool_errors') — 3 cases
 */
import { describe, expect, test, mock, afterEach, spyOn } from 'bun:test'
import { isTelegramCommand, handleTelegramCommand, type TelegramCommandDeps } from '../commands.js'
import { ConversationManager } from '../../discord/conversation.js'
import type { Context } from 'grammy'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal grammy Context mock — only ctx.reply is exercised by commands.ts */
function makeCtx() {
  const replies: string[] = []
  const ctx = {
    chat: { id: 42 },
    from: { id: 99 },
    message: { message_id: 1, text: '/cost' },
    reply: mock(async (text: string, _opts?: unknown) => {
      replies.push(text)
      return { message_id: 200 + replies.length }
    }),
    replyWithChatAction: mock(async () => {}),
    api: { editMessageText: mock(async () => {}) },
  } as unknown as Context
  return { ctx, replies }
}

const CHAT_ID = '42'
const AUTHOR_ID = '99'

/** Minimal TelegramCommandDeps factory — all injected, none hitting real I/O */
function makeDeps(overrides: Partial<TelegramCommandDeps> = {}): TelegramCommandDeps {
  const conversations = new ConversationManager(40)

  const provider = {
    name: 'test',
    stream: mock(async (
      _msgs: unknown[],
      _tools: unknown[],
      opts: { onTextChunk?: (c: string) => void; maxTokens?: number },
    ) => {
      opts.onTextChunk?.('Summary text')
      return {
        text: 'Summary text',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: 'end_turn',
      }
    }),
  }

  const registry = {
    getAll: () => [],
    toAPISchema: () => [],
    find: () => undefined,
  }

  const config = {
    temperature: 0,
    windowSize: 10,
    toolTimeoutMs: 30_000,
    telegram: { tokenEnv: 'TELEGRAM_BOT_TOKEN', ownerChatId: '99' },
  } as never

  return {
    config,
    provider: provider as never,
    registry: registry as never,
    conversations,
    model: 'test-model',
    sessionMapping: {},
    // Default no-op injectables
    loadUsageRecordsFn: mock(async () => []),
    getRecentErrorsFn: mock(() => []),
    handleOrchestrateCommandFn: mock(async () => {}),
    writeFileSyncFn: mock(() => {}),
    readFileSyncFn: mock(() => '{}'),
    existsSyncFn: mock(() => false),
    spawnFn: mock(() => ({ pid: 123, exited: Promise.resolve(0) }) as never),
    ...overrides,
  }
}

// ── isTelegramCommand ─────────────────────────────────────────────────────────

describe('isTelegramCommand', () => {
  // TRUE cases
  test('returns true for /cost', () => {
    expect(isTelegramCommand('/cost')).toBe(true)
  })
  test('returns true for /cost with trailing space', () => {
    expect(isTelegramCommand('/cost ')).toBe(true)
  })
  test('returns true for /context', () => {
    expect(isTelegramCommand('/context')).toBe(true)
  })
  test('returns true for /compact', () => {
    expect(isTelegramCommand('/compact')).toBe(true)
  })
  test('returns true for /model', () => {
    expect(isTelegramCommand('/model')).toBe(true)
  })
  test('returns true for /model haiku', () => {
    expect(isTelegramCommand('/model haiku')).toBe(true)
  })
  test('returns true for /clear', () => {
    expect(isTelegramCommand('/clear')).toBe(true)
  })
  test('returns true for /tool_errors', () => {
    expect(isTelegramCommand('/tool_errors')).toBe(true)
  })
  test('returns true for /tool_errors 1h', () => {
    expect(isTelegramCommand('/tool_errors 1h')).toBe(true)
  })
  test('returns true for /orchestrate', () => {
    expect(isTelegramCommand('/orchestrate')).toBe(true)
  })
  test('returns true for /orchestrate run-x', () => {
    expect(isTelegramCommand('/orchestrate run-x')).toBe(true)
  })
  test('returns true for !orchestrate run-x', () => {
    expect(isTelegramCommand('!orchestrate run-x')).toBe(true)
  })

  // FALSE cases
  test('returns false for empty string', () => {
    expect(isTelegramCommand('')).toBe(false)
  })
  test('returns false for plain text', () => {
    expect(isTelegramCommand('hello')).toBe(false)
  })
  test('returns false for unknown command', () => {
    expect(isTelegramCommand('/unknown')).toBe(false)
  })
  test('returns false for cost without slash', () => {
    expect(isTelegramCommand('cost')).toBe(false)
  })
  test('returns false for /costless (prefix match guard)', () => {
    expect(isTelegramCommand('/costless')).toBe(false)
  })
})

// ── /cost (TGCMDS-01) ────────────────────────────────────────────────────────

describe('handleTelegramCommand /cost (TGCMDS-01)', () => {
  test('replies "No usage recorded today." when no usage records', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps({
      loadUsageRecordsFn: mock(async () => []),
    })
    await handleTelegramCommand(ctx, '/cost', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).toBe('No usage recorded today.')
  })

  test('replies with token figures when usage records exist', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps({
      loadUsageRecordsFn: mock(async () => [
        {
          ts: new Date().toISOString(),
          channelId: CHAT_ID,
          userId: AUTHOR_ID,
          model: 'test-model',
          inputTokens: 1000,
          outputTokens: 500,
        },
      ]),
    })
    await handleTelegramCommand(ctx, '/cost', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).not.toBe('No usage recorded today.')
    // Should contain token numbers
    const reply = replies[0]
    expect(reply.length).toBeGreaterThan(10)
  })
})

// ── /context (TGCMDS-02) ─────────────────────────────────────────────────────

describe('handleTelegramCommand /context (TGCMDS-02)', () => {
  test('replies with file labels when sharedContext has files', async () => {
    const { ctx, replies } = makeCtx()
    const sharedContext = {
      files: [
        { path: '/home/.claude/CLAUDE.md', content: '', source: 'global' as const, label: 'CLAUDE.md', bytes: 100, estimatedTokens: 25 },
        { path: '/project/MEMORY.md', content: '', source: 'project' as const, label: 'MEMORY.md', bytes: 200, estimatedTokens: 50 },
      ],
      systemPromptPrefix: '',
      totalBytes: 300,
      totalEstimatedTokens: 75,
      budgetWarning: null,
    }
    const deps = makeDeps({ sharedContext })
    await handleTelegramCommand(ctx, '/context', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).toContain('CLAUDE.md')
    expect(replies[0]).toContain('25')
    expect(replies[0]).toContain('MEMORY.md')
    expect(replies[0]).toContain('50')
  })

  test('replies "No context files loaded." when sharedContext has no files', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps({ sharedContext: undefined })
    await handleTelegramCommand(ctx, '/context', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).toBe('No context files loaded.')
  })
})

// ── /compact (TGCMDS-03) ─────────────────────────────────────────────────────

describe('handleTelegramCommand /compact (TGCMDS-03)', () => {
  test('replies "Nothing to compact." when history is empty', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps()
    // conversations has no history for CHAT_ID — empty by default
    await handleTelegramCommand(ctx, '/compact', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).toBe('Nothing to compact.')
    // provider.stream must NOT have been called
    const streamSpy = deps.provider.stream as ReturnType<typeof mock>
    expect(streamSpy.mock.calls.length).toBe(0)
  })

  test('calls provider.stream, clears + reseeds history, replies with confirmation when history is non-empty', async () => {
    const { ctx, replies } = makeCtx()
    const conversations = new ConversationManager(40)
    conversations.addUserMessage(CHAT_ID, 'Hello agent')
    conversations.addAssistantMessage(CHAT_ID, 'Hello user')

    const streamMock = mock(async (
      _msgs: unknown[],
      _tools: unknown[],
      opts: { onTextChunk?: (c: string) => void; maxTokens?: number },
    ) => {
      opts.onTextChunk?.('Compacted content here')
      return {
        text: 'Compacted content here',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: 'end_turn',
      }
    })

    const deps = makeDeps({
      conversations,
      provider: { name: 'test', stream: streamMock } as never,
    })

    // spy on conversations methods
    const clearSpy = spyOn(conversations, 'clear')
    const addAssistantSpy = spyOn(conversations, 'addAssistantMessage')

    await handleTelegramCommand(ctx, '/compact', CHAT_ID, AUTHOR_ID, deps)

    // provider.stream called once with empty tools
    expect(streamMock.mock.calls.length).toBe(1)
    const [_msgs, tools] = streamMock.mock.calls[0] as [unknown[], unknown[], unknown]
    expect(tools).toEqual([])

    // conversations.clear called with chatId
    expect(clearSpy.mock.calls.length).toBe(1)
    expect(clearSpy.mock.calls[0][0]).toBe(CHAT_ID)

    // conversations.addAssistantMessage called with chatId + summary text
    expect(addAssistantSpy.mock.calls.length).toBe(1)
    expect(addAssistantSpy.mock.calls[0][0]).toBe(CHAT_ID)

    // ctx.reply called with confirmation containing 'compact' or 'summar'
    expect(replies.length).toBe(1)
    const lower = replies[0].toLowerCase()
    expect(lower.includes('compact') || lower.includes('summar')).toBe(true)
  })
})

// ── /model (TGCMDS-04) ───────────────────────────────────────────────────────

describe('handleTelegramCommand /model (TGCMDS-04)', () => {
  test('shows current model and available presets when no arg', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps()
    await handleTelegramCommand(ctx, '/model', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0]).toContain('Current model:')
    // Should list at least the preset names
    const reply = replies[0]
    expect(reply.includes('haiku') || reply.includes('glm') || reply.includes('deepseek')).toBe(true)
  })

  test('writes telegram-model-state.json and spawns launchctl for valid preset', async () => {
    const { ctx } = makeCtx()
    const writeFileSyncFn = mock((_path: string, _data: string) => {})
    const spawnFn = mock((_args: string[], _opts?: unknown) => ({ pid: 1, exited: Promise.resolve(0) }) as never)
    const deps = makeDeps({ writeFileSyncFn, spawnFn, existsSyncFn: mock(() => false) })

    await handleTelegramCommand(ctx, '/model haiku', CHAT_ID, AUTHOR_ID, deps)

    // writeFileSyncFn called — path contains telegram-model-state.json
    expect(writeFileSyncFn.mock.calls.length).toBe(1)
    const [writePath, writeData] = writeFileSyncFn.mock.calls[0] as [string, string]
    expect(writePath).toContain('telegram-model-state.json')
    // Data contains the haiku model
    expect(writeData).toContain('anthropic')
    expect(writeData).toContain('claude-haiku-4-5-20251001')

    // spawnFn called with launchctl args including com.telemachus.telegram (NOT discord)
    expect(spawnFn.mock.calls.length).toBe(1)
    const [launchArgs] = spawnFn.mock.calls[0] as [string[], unknown]
    const argsStr = launchArgs.join(' ')
    expect(argsStr).toContain('com.telemachus.telegram')
    expect(argsStr).not.toContain('com.telemachus.discord')
  })

  test('replies with "Unknown model" for unknown preset', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps()
    await handleTelegramCommand(ctx, '/model unknownxyz', CHAT_ID, AUTHOR_ID, deps)
    expect(replies.length).toBe(1)
    expect(replies[0].toLowerCase()).toContain('unknown model')
  })

  test('launchctl kickstart uses com.telemachus.telegram label', async () => {
    const { ctx } = makeCtx()
    const spawnFn = mock((_args: string[], _opts?: unknown) => ({ pid: 1, exited: Promise.resolve(0) }) as never)
    const deps = makeDeps({ spawnFn, writeFileSyncFn: mock(() => {}), existsSyncFn: mock(() => false) })

    await handleTelegramCommand(ctx, '/model glm', CHAT_ID, AUTHOR_ID, deps)

    expect(spawnFn.mock.calls.length).toBe(1)
    const [launchArgs] = spawnFn.mock.calls[0] as [string[], unknown]
    const label = launchArgs.find((a) => a.includes('com.telemachus'))
    expect(label).toBeDefined()
    expect(label).toContain('com.telemachus.telegram')
  })
})

// ── /clear (TGCMDS-05) ───────────────────────────────────────────────────────

describe('handleTelegramCommand /clear (TGCMDS-05)', () => {
  test('calls conversations.clear with chatId and replies with confirmation', async () => {
    const { ctx, replies } = makeCtx()
    const conversations = new ConversationManager(40)
    const clearSpy = spyOn(conversations, 'clear')
    const deps = makeDeps({ conversations })

    await handleTelegramCommand(ctx, '/clear', CHAT_ID, AUTHOR_ID, deps)

    expect(clearSpy.mock.calls.length).toBe(1)
    expect(clearSpy.mock.calls[0][0]).toBe(CHAT_ID)
    expect(replies.length).toBe(1)
    expect(replies[0].length).toBeGreaterThan(0)
  })
})

// ── /orchestrate (TGCMDS-06) ─────────────────────────────────────────────────

describe('handleTelegramCommand /orchestrate (TGCMDS-06)', () => {
  test('calls handleOrchestrateCommandFn with sendDm: undefined', async () => {
    const { ctx } = makeCtx()
    const orchestrateFn = mock(async () => {})
    const deps = makeDeps({ handleOrchestrateCommandFn: orchestrateFn })

    await handleTelegramCommand(ctx, '/orchestrate run-x', CHAT_ID, AUTHOR_ID, deps)

    expect(orchestrateFn.mock.calls.length).toBe(1)
    const [_msg, callDeps] = orchestrateFn.mock.calls[0] as [unknown, { sendDm?: unknown }]
    expect(callDeps.sendDm).toBeUndefined()
  })
})

// ── /tool_errors (TGCMDS-07) ─────────────────────────────────────────────────

describe('handleTelegramCommand /tool_errors (TGCMDS-07)', () => {
  test('calls getRecentErrorsFn with default 15m window', async () => {
    const { ctx, replies } = makeCtx()
    const getRecentErrorsFn = mock((_windowMs: number, _limit: number) => [])
    const deps = makeDeps({ getRecentErrorsFn })

    await handleTelegramCommand(ctx, '/tool_errors', CHAT_ID, AUTHOR_ID, deps)

    expect(getRecentErrorsFn.mock.calls.length).toBe(1)
    const [windowMs] = getRecentErrorsFn.mock.calls[0] as [number, number]
    expect(windowMs).toBe(15 * 60_000)
    expect(replies.length).toBe(1)
  })

  test('calls getRecentErrorsFn with 1h window for /tool_errors 1h', async () => {
    const { ctx } = makeCtx()
    const getRecentErrorsFn = mock((_windowMs: number, _limit: number) => [])
    const deps = makeDeps({ getRecentErrorsFn })

    await handleTelegramCommand(ctx, '/tool_errors 1h', CHAT_ID, AUTHOR_ID, deps)

    expect(getRecentErrorsFn.mock.calls.length).toBe(1)
    const [windowMs] = getRecentErrorsFn.mock.calls[0] as [number, number]
    expect(windowMs).toBe(60 * 60_000)
  })

  test('replies with "Unsupported window" for /tool_errors 999d', async () => {
    const { ctx, replies } = makeCtx()
    const deps = makeDeps()

    await handleTelegramCommand(ctx, '/tool_errors 999d', CHAT_ID, AUTHOR_ID, deps)

    expect(replies.length).toBe(1)
    expect(replies[0].startsWith('Unsupported window')).toBe(true)
  })
})
