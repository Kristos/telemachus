import type { Message } from '../../providers/types.js'
import { messageText } from '../../providers/types.js'

function asText(c: Message['content']): string {
  if (c == null) return ''
  if (typeof c === 'string') return c
  return messageText(c)
}

export interface ExportMeta {
  sessionId: string
  model: string
  providerKey: string
  startedAt?: number
}

/**
 * Serialise a Message[] into a Markdown transcript.
 *
 * Pure function — no fs, no Bun.write. Plan 02 handles disk I/O.
 *
 * NOTE: This project's Message shape stores tool calls as a sibling
 * `toolCalls` array on the assistant message rather than as inline
 * content blocks. Tool results arrive as separate messages with
 * `role: 'tool'` and a string `content` payload. The renderer matches
 * that actual schema.
 */
export function exportSessionToMarkdown(
  messages: Message[],
  meta: ExportMeta,
): string {
  const startedLine =
    meta.startedAt !== undefined
      ? new Date(meta.startedAt).toISOString()
      : 'unknown'

  const lines: string[] = []
  lines.push(`# Session ${meta.sessionId}`)
  lines.push('')
  lines.push(`- model: ${meta.providerKey}/${meta.model}`)
  lines.push(`- started: ${startedLine}`)
  lines.push(`- messages: ${messages.length}`)
  lines.push('')
  lines.push('---')

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      lines.push('')
      lines.push('## User')
      lines.push('')
      lines.push(asText(message.content))
      continue
    }

    if (message.role === 'assistant') {
      lines.push('')
      lines.push('## Assistant')
      lines.push('')
      const t = asText(message.content)
      if (t) lines.push(t)
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const call of message.toolCalls) {
          lines.push('')
          lines.push(`**Tool call:** \`${call.name}\` \`${JSON.stringify(call.input)}\``)
        }
      }
      continue
    }

    if (message.role === 'tool') {
      lines.push('')
      lines.push('### Tool result')
      lines.push('')
      lines.push('```')
      lines.push(asText(message.content))
      lines.push('```')
      continue
    }
  }

  return lines.join('\n')
}
