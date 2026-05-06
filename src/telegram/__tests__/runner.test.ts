/**
 * Phase 70 Plan 03 (TGAGENT-01..04): runner.ts unit tests.
 *
 * Exercises handleTelegramMessage wiring with mocked deps:
 *   - provider.stream returns a fixed text with HTML-special chars
 *   - Verifies user + assistant messages land in ConversationManager
 *   - Verifies ctx.reply called with '...' placeholder in HTML mode
 *   - Verifies final edit body is HTML-escaped
 *   - Verifies empty messages are skipped (no ctx.reply)
 */
import { describe, expect, test, mock } from 'bun:test'
import { handleTelegramMessage, type TelegramRunnerDeps } from '../runner.js'
import { ConversationManager } from '../../discord/conversation.js'

function makeCtx(overrides: Record<string, unknown> = {}) {
  const sentMessages: string[] = []
  const editedMessages: Array<[string, number, string]> = []
  const ctx: Record<string, unknown> = {
    chat: { id: 12345 },
    from: { id: 67890 },
    message: { message_id: 100, text: 'hi agent' },
    reply: mock(async (text: string, _opts?: unknown) => {
      sentMessages.push(text)
      return { message_id: 200 + sentMessages.length }
    }),
    replyWithChatAction: mock(async () => {}),
    api: {
      editMessageText: mock(async (cid: string, mid: number, text: string, _opts?: unknown) => {
        editedMessages.push([cid, mid, text])
      }),
    },
    ...overrides,
  }
  return { ctx, sentMessages, editedMessages }
}

function makeDeps(): TelegramRunnerDeps {
  const conversations = new ConversationManager(40)
  // Mock provider whose stream() returns a fixed text with HTML-special chars
  const provider: Record<string, unknown> = {
    stream: mock(async (_msgs: unknown[], _schemas: unknown[], opts: Record<string, unknown>) => {
      if (opts?.['onTextChunk']) {
        const onChunk = opts['onTextChunk'] as (chunk: string) => void
        onChunk('Hello ')
        onChunk('<world>')
      }
      return {
        text: 'Hello <world>',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
    }),
  }
  const registry: Record<string, unknown> = {
    getAll: () => [],
    toAPISchema: () => [],
    find: () => undefined,
  }
  const mapping: Record<string, string> = {}
  return {
    config: {
      temperature: 0,
      windowSize: 10,
      toolTimeoutMs: 30_000,
      telegram: { tokenEnv: 'TELEGRAM_BOT_TOKEN', ownerChatId: '67890' },
    } as never,
    provider: provider as never,
    registry: registry as never,
    conversations,
    sessionMapping: mapping,
    model: 'test-model',
  }
}

describe('handleTelegramMessage (TGAGENT-01..04)', () => {
  test('records user + assistant message in ConversationManager', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx()
    const onMessage = handleTelegramMessage(deps)
    await onMessage(ctx as never)
    // Wait for enqueue closure to settle
    await new Promise(r => setTimeout(r, 100))

    const history = deps.conversations.getHistory('12345')
    // Expect at least 2 entries: user "hi agent" + assistant "Hello <world>"
    const userMsg = history.find((m) => m.role === 'user')
    const asstMsg = history.find((m) => m.role === 'assistant')
    expect(userMsg).toBeDefined()
    expect(asstMsg).toBeDefined()
    expect((asstMsg!.content as string)).toContain('Hello')
  })

  test('sends placeholder via ctx.reply with parse_mode HTML', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx()
    const onMessage = handleTelegramMessage(deps)
    await onMessage(ctx as never)
    await new Promise(r => setTimeout(r, 100))

    // reply was called at least once (placeholder); first call body is '...'
    expect(ctx.reply).toHaveBeenCalled()
    const firstCall = (ctx.reply as ReturnType<typeof mock>).mock.calls[0]!
    expect(firstCall[0]).toBe('...')
    expect(firstCall[1]).toEqual({ parse_mode: 'HTML' })
  })

  test('finalize edits placeholder with HTML-escaped response', async () => {
    const deps = makeDeps()
    const { ctx, editedMessages } = makeCtx()
    const onMessage = handleTelegramMessage(deps)
    await onMessage(ctx as never)
    await new Promise(r => setTimeout(r, 100))

    // editMessageText was called at least once with escaped text
    expect(editedMessages.length).toBeGreaterThanOrEqual(1)
    const lastEdit = editedMessages[editedMessages.length - 1]!
    expect(lastEdit[2]).toBe('Hello &lt;world&gt;')
  })

  test('skips empty messages', async () => {
    const deps = makeDeps()
    const { ctx } = makeCtx({ message: { message_id: 100, text: '' } })
    const onMessage = handleTelegramMessage(deps)
    await onMessage(ctx as never)
    await new Promise(r => setTimeout(r, 50))
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
