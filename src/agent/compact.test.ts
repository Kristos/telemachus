import { describe, test, expect } from 'bun:test'
import { compactMessages, keepLastTurns, previewCompact } from './compact.js'
import type { Message, Provider } from '../providers/types.js'

const mockProvider: Provider = {
  name: 'mock',
  async stream() {
    return {
      text: 'Summary of conversation',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    }
  },
}

function u(content: string): Message {
  return { role: 'user', content }
}
function a(content: string): Message {
  return { role: 'assistant', content }
}

describe('keepLastTurns', () => {
  test('returns [] for empty input', () => {
    expect(keepLastTurns([], 3)).toEqual([])
  })

  test('returns all messages when fewer turns than requested', () => {
    const msgs = [u('hi'), a('hello')]
    expect(keepLastTurns(msgs, 3)).toEqual(msgs)
  })

  test('returns last 3 turns (6 messages) from 5 user-assistant pairs', () => {
    const msgs: Message[] = [
      u('1'), a('1r'),
      u('2'), a('2r'),
      u('3'), a('3r'),
      u('4'), a('4r'),
      u('5'), a('5r'),
    ]
    const result = keepLastTurns(msgs, 3)
    expect(result).toHaveLength(6)
    expect(result[0]).toEqual(u('3'))
    expect(result[5]).toEqual(a('5r'))
  })

  test('never splits tool_use/tool_result pairs', () => {
    const msgs: Message[] = [
      u('old'),
      a('old reply'),
      u('use tool'),
      { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', content: 'result', toolCallId: 't1' },
      a('done'),
      u('next'),
      a('reply'),
    ]
    const result = keepLastTurns(msgs, 2)
    // Last 2 turns: "use tool" turn (with tool pair + done) + "next" turn
    expect(result[0]).toEqual(u('use tool'))
    expect(result).toContainEqual({ role: 'tool', content: 'result', toolCallId: 't1' })
    expect(result[result.length - 1]).toEqual(a('reply'))
  })

  test('single turn returned intact', () => {
    const msgs = [u('only'), a('only reply')]
    expect(keepLastTurns(msgs, 3)).toEqual(msgs)
  })
})

describe('compactMessages', () => {
  test('returns CompactResult with summary + ack + last turns', async () => {
    const msgs: Message[] = [
      u('1'), a('1r'),
      u('2'), a('2r'),
      u('3'), a('3r'),
      u('4'), a('4r'),
    ]
    const result = await compactMessages(msgs, mockProvider, 'system')
    expect(result.beforeMessageCount).toBe(8)
    expect(result.afterMessageCount).toBe(result.messages.length)
    expect(result.summaryTokens).toBe(50)

    // First: summary user msg
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toContain('[CONVERSATION SUMMARY]')
    expect(result.messages[0].content).toContain('[END SUMMARY]')
    expect(result.messages[0].content).toContain('Summary of conversation')

    // Second: assistant ack
    expect(result.messages[1].role).toBe('assistant')
    expect(result.messages[1].content).toContain('I have the context from the summary')

    // Tail: last 3 turns
    expect(result.messages.length).toBe(2 + 6)
  })
})

describe('previewCompact', () => {
  test('returns preview without mutating caller messages', async () => {
    const msgs: Message[] = [
      u('1'), a('1r'),
      u('2'), a('2r'),
      u('3'), a('3r'),
      u('4'), a('4r'),
    ]
    const snapshot = msgs.slice()
    const preview = await previewCompact(msgs, mockProvider, 'system')

    // Caller messages untouched
    expect(msgs).toEqual(snapshot)
    expect(msgs.length).toBe(8)

    // Preview shape
    expect(preview.summary).toBe('Summary of conversation')
    expect(preview.summaryTokens).toBe(50)
    expect(preview.beforeMessageCount).toBe(8)
    expect(preview.afterMessageCount).toBe(preview.newMessages.length)
    expect(preview.newMessages[0].role).toBe('user')
    expect(preview.newMessages[0].content).toContain('[CONVERSATION SUMMARY]')
  })

  test('compactMessages remains a thin wrapper around previewCompact', async () => {
    const msgs: Message[] = [u('1'), a('1r'), u('2'), a('2r')]
    const result = await compactMessages(msgs, mockProvider, 'system')
    const preview = await previewCompact(msgs, mockProvider, 'system')
    expect(result.messages).toEqual(preview.newMessages)
    expect(result.beforeMessageCount).toBe(preview.beforeMessageCount)
    expect(result.afterMessageCount).toBe(preview.afterMessageCount)
    expect(result.summaryTokens).toBe(preview.summaryTokens)
  })
})
