/**
 * Phase 65 (HYG-01): Tests for message-intake.ts — attachment fetching +
 * message normalization (guild → thread, multimodal content assembly).
 *
 * Uses spyOn(globalThis, 'fetch') to mock attachment downloads.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import {
  fetchAttachment,
  normalizeIncomingMessage,
  IMAGE_MIME_TYPES,
  MAX_TEXT_SIZE,
  type DiscordAttachment,
  type DiscordMessage,
} from './message-intake.js'

function makeAttachment(overrides: Partial<DiscordAttachment> = {}): DiscordAttachment {
  return {
    url: 'https://cdn.discordapp.com/attachments/fake.png',
    name: 'fake.png',
    contentType: 'image/png',
    size: 1024,
    ...overrides,
  }
}

function makeMsg(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    channelId: 'ch-123',
    content: 'hello',
    authorId: 'user-1',
    reply: async () => {},
    sendTyping: async () => {},
    isGuild: false,
    ...overrides,
  }
}

// ─── fetchAttachment ──────────────────────────────────────────────────────

describe('fetchAttachment', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('returns an image block for image/png attachments', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])  // "\x89PNG"
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(bytes, { status: 200 }),
    )

    const result = await fetchAttachment(makeAttachment({ contentType: 'image/png' }))

    expect(result).not.toBeNull()
    expect(result?.type).toBe('image')
    if (result?.type === 'image') {
      expect(result.mediaType).toBe('image/png')
      expect(result.base64).toBe(Buffer.from(bytes).toString('base64'))
    }
  })

  it('accepts all supported image MIME types', () => {
    // Regression guard against accidental IMAGE_MIME_TYPES narrowing
    expect(IMAGE_MIME_TYPES.has('image/png')).toBe(true)
    expect(IMAGE_MIME_TYPES.has('image/jpeg')).toBe(true)
    expect(IMAGE_MIME_TYPES.has('image/gif')).toBe(true)
    expect(IMAGE_MIME_TYPES.has('image/webp')).toBe(true)
  })

  it('returns a text block for small text attachments', async () => {
    const text = 'hello world'
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(text, { status: 200 }),
    )

    const result = await fetchAttachment(
      makeAttachment({ contentType: 'text/plain', name: 'notes.txt', size: text.length }),
    )

    expect(result).not.toBeNull()
    expect(result?.type).toBe('text')
    if (result?.type === 'text') {
      expect(result.name).toBe('notes.txt')
      expect(result.content).toBe(text)
    }
  })

  it('returns [File too large] placeholder when attachment exceeds MAX_TEXT_SIZE', async () => {
    // Body need not actually exist; size field alone gates the truncation
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('body', { status: 200 }),
    )

    const oversize = MAX_TEXT_SIZE + 1
    const result = await fetchAttachment(
      makeAttachment({
        contentType: 'application/json',
        name: 'big.json',
        size: oversize,
      }),
    )

    expect(result?.type).toBe('text')
    if (result?.type === 'text') {
      expect(result.content).toContain('[File too large')
      expect(result.content).toContain('big.json')
    }
  })

  it('returns null when fetch fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => { throw new Error('ECONNREFUSED') },
    )

    const result = await fetchAttachment(makeAttachment())
    expect(result).toBeNull()
  })

  it('returns null when response is not ok (HTTP 404)', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('not found', { status: 404 }),
    )

    const result = await fetchAttachment(makeAttachment())
    expect(result).toBeNull()
  })
})

// ─── normalizeIncomingMessage ─────────────────────────────────────────────

describe('normalizeIncomingMessage', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('DM passes through unchanged (same channelId, same send helpers)', async () => {
    const replies: string[] = []
    const typings: number[] = []
    const msg = makeMsg({
      channelId: 'dm-channel',
      content: 'hi there',
      reply: async (text) => { replies.push(text) },
      sendTyping: async () => { typings.push(1) },
    })

    const result = await normalizeIncomingMessage(msg)

    expect(result.targetChannelId).toBe('dm-channel')
    expect(result.enrichedContent).toBe('hi there')
    expect(result.imageBlocks).toHaveLength(0)

    await result.replySend('response')
    await result.replySendTyping()
    expect(replies).toEqual(['response'])
    expect(typings).toEqual([1])
  })

  it('guild message with createThread routes replies to the new thread', async () => {
    const threadReplies: string[] = []
    const msg = makeMsg({
      channelId: 'guild-channel',
      content: 'help me with X',
      isGuild: true,
      createThread: async (name: string) => {
        expect(name).toBe('help me with X')
        return {
          id: 'thread-abc',
          send: async (text) => { threadReplies.push(text) },
          sendTyping: async () => {},
        }
      },
    })

    const result = await normalizeIncomingMessage(msg)

    expect(result.targetChannelId).toBe('thread-abc')
    await result.replySend('routed reply')
    expect(threadReplies).toEqual(['routed reply'])
  })

  it('guild with empty content uses default thread name', async () => {
    const msg = makeMsg({
      channelId: 'guild-channel',
      content: '',
      isGuild: true,
      createThread: async (name: string) => {
        expect(name).toBe('Agent conversation')
        return {
          id: 'thread-xyz',
          send: async () => {},
          sendTyping: async () => {},
        }
      },
    })

    const result = await normalizeIncomingMessage(msg)
    expect(result.targetChannelId).toBe('thread-xyz')
  })

  it('text attachment content is appended to enrichedContent', async () => {
    const attBody = 'function main() {}\n'
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(attBody, { status: 200 }),
    )

    const msg = makeMsg({
      content: 'please review',
      attachments: [
        makeAttachment({
          contentType: 'text/plain',
          name: 'code.ts',
          size: attBody.length,
        }),
      ],
    })

    const result = await normalizeIncomingMessage(msg)

    expect(result.enrichedContent).toBe('please review\n\n--- code.ts ---\nfunction main() {}\n')
    expect(result.imageBlocks).toHaveLength(0)
  })

  it('image attachments populate imageBlocks with base64 payload', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(bytes, { status: 200 }),
    )

    const msg = makeMsg({
      content: 'look',
      attachments: [
        makeAttachment({ contentType: 'image/jpeg', name: 'photo.jpg', size: bytes.byteLength }),
      ],
    })

    const result = await normalizeIncomingMessage(msg)

    expect(result.imageBlocks).toHaveLength(1)
    expect(result.imageBlocks[0]!.type).toBe('image')
    expect(result.imageBlocks[0]!.source.type).toBe('base64')
    expect(result.imageBlocks[0]!.source.mediaType).toBe('image/jpeg')
    expect(result.imageBlocks[0]!.source.data).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('failed attachment fetch is silently skipped (no throw, no block)', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => { throw new Error('network down') },
    )

    const msg = makeMsg({
      content: 'hello',
      attachments: [makeAttachment()],
    })

    const result = await normalizeIncomingMessage(msg)

    expect(result.enrichedContent).toBe('hello')
    expect(result.imageBlocks).toHaveLength(0)
  })
})
