/**
 * Phase 65 (HYG-01): Tests for reply-writer.ts — streaming Discord reply
 * lifecycle. Uses fake msg/send handles + short editIntervalMs to test
 * without real Discord or real timers.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { createReplyWriter } from './reply-writer.js'
import type { DiscordMessage } from './message-intake.js'

function makeMsg(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    channelId: 'ch-1',
    content: 'hi',
    authorId: 'user-1',
    reply: async () => {},
    sendTyping: async () => {},
    isGuild: false,
    ...overrides,
  }
}

async function flush(ms = 10): Promise<void> {
  await new Promise<void>(r => setTimeout(r, ms))
}

describe('reply-writer', () => {
  it('appendChunk accumulates into the internal buffer', () => {
    const writer = createReplyWriter({
      msg: makeMsg(),
      replySend: async () => {},
      replySendTyping: async () => {},
      userId: 'u',
      channelId: 'c',
    })

    writer.appendChunk('hello')
    writer.appendChunk(' ')
    writer.appendChunk('world')
    expect(writer.getBuffer()).toBe('hello world')
    writer.stop()
  })

  it('finalize edits placeholder with first chunk when replyEditable is present', async () => {
    const editCalls: string[] = []
    const replies: string[] = []
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async (text) => { editCalls.push(text) },
      }),
      reply: async (text) => { replies.push(text) },
    })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,  // disable stream edits via long interval
    })
    await writer.start()
    await writer.finalize('short response')
    writer.stop()

    // First edit was the '...' placeholder post (during start()), then the final edit.
    expect(editCalls).toContain('short response')
    expect(replies).toEqual([])
  })

  it('finalize falls back to replySend when no replyEditable', async () => {
    const replies: string[] = []
    const msg = makeMsg({ reply: async (text) => { replies.push(text) } })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    await writer.finalize('plain response')
    writer.stop()

    expect(replies).toEqual(['plain response'])
  })

  it('finalize with multi-chunk response edits placeholder first, sends follow-ups via replySend', async () => {
    const editCalls: string[] = []
    const replies: string[] = []
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async (text) => { editCalls.push(text) },
      }),
      reply: async (text) => { replies.push(text) },
    })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    // Build a response longer than the 2000-char Discord limit to force multi-chunk.
    const long = 'A'.repeat(2000) + 'B'.repeat(2000)
    await writer.finalize(long)
    writer.stop()

    // First chunk went to placeholder edit, second chunk to replySend.
    expect(editCalls.some(e => e.startsWith('A'))).toBe(true)
    expect(replies.length).toBeGreaterThan(0)
  })

  it('finalize falls back to replySend when placeholder.edit throws', async () => {
    const replies: string[] = []
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async () => { throw new Error('message deleted') },
      }),
      reply: async (text) => { replies.push(text) },
    })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    await writer.finalize('fallback response')
    writer.stop()

    expect(replies).toEqual(['fallback response'])
  })

  it('replyError posts error text via placeholder when available', async () => {
    const editCalls: string[] = []
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async (text) => { editCalls.push(text) },
      }),
    })

    const writer = createReplyWriter({
      msg,
      replySend: async () => {},
      replySendTyping: async () => {},
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    await writer.replyError('Agent error: boom')
    writer.stop()

    expect(editCalls).toContain('Agent error: boom')
  })

  it('replyError falls back to replySend when placeholder.edit throws', async () => {
    const replies: string[] = []
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async () => { throw new Error('rate limit') },
      }),
      reply: async (text) => { replies.push(text) },
    })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    await writer.replyError('Agent error: boom')
    writer.stop()

    expect(replies).toEqual(['Agent error: boom'])
  })

  it('replyError log-swallows when both placeholder and replySend throw', async () => {
    const msg = makeMsg({
      replyEditable: async () => ({
        edit: async () => { throw new Error('edit fail') },
      }),
      reply: async () => { throw new Error('send fail') },
    })

    const writer = createReplyWriter({
      msg,
      replySend: msg.reply,
      replySendTyping: msg.sendTyping,
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 10_000,
    })
    await writer.start()
    // Must not throw even when both fallbacks fail.
    await writer.replyError('Agent error: boom')
    writer.stop()

    // Pass if we got here without throwing.
    expect(true).toBe(true)
  })

  it('stop is idempotent — multiple calls do not throw', async () => {
    const writer = createReplyWriter({
      msg: makeMsg(),
      replySend: async () => {},
      replySendTyping: async () => {},
      userId: 'u',
      channelId: 'c',
    })
    await writer.start()
    writer.stop()
    writer.stop()
    writer.stop()
    expect(writer.getBuffer()).toBe('')
  })

  it('start → stop without finalize still clears the edit interval', async () => {
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval')
    const writer = createReplyWriter({
      msg: makeMsg(),
      replySend: async () => {},
      replySendTyping: async () => {},
      userId: 'u',
      channelId: 'c',
      editIntervalMs: 100,
    })
    await writer.start()
    const initialClears = clearIntervalSpy.mock.calls.length
    writer.stop()
    await flush()
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(initialClears)
    clearIntervalSpy.mockRestore()
  })
})
