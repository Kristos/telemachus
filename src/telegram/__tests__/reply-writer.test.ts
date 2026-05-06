import { describe, expect, test, mock } from 'bun:test'
import { createTelegramReplyWriter } from '../reply-writer.js'

function makeOpts(overrides: Record<string, unknown> = {}) {
  const sendMessage = mock(async (_text: string) => ({ message_id: 42 }))
  const replySend = mock(async (_text: string) => {})
  const replySendTyping = mock(async () => {})
  const editMessage = mock(async (_c: string, _m: number, _t: string) => {})
  return {
    opts: {
      chatId: '12345',
      sendMessage,
      replySend,
      replySendTyping,
      editMessage,
      userId: '67890',
      editIntervalMs: 20, // tight for tests
      ...overrides,
    },
    sendMessage,
    replySend,
    replySendTyping,
    editMessage,
  }
}

describe('TelegramReplyWriter (TGAGENT-02)', () => {
  test('start posts placeholder and triggers typing', async () => {
    const { opts, sendMessage, replySendTyping } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    w.stop()
    expect(replySendTyping).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    // Placeholder body should be escapeHtml('...') === '...'
    expect(sendMessage.mock.calls[0]![0]).toBe('...')
  })

  test('interval edits placeholder with escaped buffer (TGAGENT-03)', async () => {
    const { opts, editMessage } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    w.appendChunk('hello <world> & friends')
    // Wait for at least one interval tick
    await new Promise((r) => setTimeout(r, 60))
    w.stop()
    expect(editMessage.mock.calls.length).toBeGreaterThanOrEqual(1)
    const lastCall = editMessage.mock.calls[editMessage.mock.calls.length - 1]!
    expect(lastCall[0]).toBe('12345')
    expect(lastCall[1]).toBe(42)
    // Text MUST be escaped
    expect(lastCall[2]).toBe('hello &lt;world&gt; &amp; friends')
  })

  test('stop clears the interval — no further edits', async () => {
    const { opts, editMessage } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    w.appendChunk('first')
    await new Promise((r) => setTimeout(r, 30))
    w.stop()
    const callsAtStop = editMessage.mock.calls.length
    w.appendChunk('second')
    await new Promise((r) => setTimeout(r, 60))
    expect(editMessage.mock.calls.length).toBe(callsAtStop)
  })

  test('finalize edits placeholder with escaped chunk[0] and replies remaining chunks', async () => {
    const { opts, editMessage, replySend } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    // 5000 chars 'a' — exceeds 4096 after escaping (no expansion since 'a' has no &<>)
    const text = 'a'.repeat(5000)
    await w.finalize(text)
    w.stop()
    expect(editMessage).toHaveBeenCalledTimes(1)
    expect(editMessage.mock.calls[0]![2]!.length).toBe(4096)
    expect(replySend).toHaveBeenCalledTimes(1)
    expect(replySend.mock.calls[0]![0]!.length).toBe(904)
  })

  test('finalize falls back to replySend when editMessage rejects (Pitfall 4)', async () => {
    const editMessage = mock(
      async () => {
        throw new Error('400 Bad Request: message to edit not found')
      },
    )
    const { opts, replySend } = makeOpts({ editMessage })
    opts.editMessage = editMessage
    const w = createTelegramReplyWriter(opts)
    await w.start()
    await w.finalize('done')
    w.stop()
    expect(replySend).toHaveBeenCalledTimes(1)
    expect(replySend.mock.calls[0]![0]).toBe('done')
  })

  test('finalize escapes HTML in final body (TGAGENT-03)', async () => {
    const { opts, editMessage } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    await w.finalize('Use <pre> & </pre>')
    w.stop()
    expect(editMessage.mock.calls[0]![2]).toBe('Use &lt;pre&gt; &amp; &lt;/pre&gt;')
  })

  test('replyError escapes and routes through editMessage when placeholder set', async () => {
    const { opts, editMessage } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    await w.replyError('Error: <foo>')
    w.stop()
    // Last editMessage call is the error
    const lastCall = editMessage.mock.calls[editMessage.mock.calls.length - 1]!
    expect(lastCall[2]).toBe('Error: &lt;foo&gt;')
  })

  test('finalize without placeholder uses replySend for all chunks', async () => {
    const sendMessage = mock(async () => {
      throw new Error('rate limit')
    })
    const { opts, replySend } = makeOpts({ sendMessage })
    opts.sendMessage = sendMessage
    const w = createTelegramReplyWriter(opts)
    await w.start() // placeholder send fails — placeholder stays null
    await w.finalize('hello')
    w.stop()
    expect(replySend).toHaveBeenCalledTimes(1)
    expect(replySend.mock.calls[0]![0]).toBe('hello')
  })

  test('getBuffer returns raw (unescaped) stream buffer', async () => {
    const { opts } = makeOpts()
    const w = createTelegramReplyWriter(opts)
    await w.start()
    w.appendChunk('raw <text> & content')
    w.stop()
    expect(w.getBuffer()).toBe('raw <text> & content')
  })
})
