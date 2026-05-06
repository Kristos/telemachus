import type { Message, Provider } from '../providers/types.js'

export interface CompactResult {
  messages: Message[]
  summaryTokens: number
  beforeMessageCount: number
  afterMessageCount: number
}

export interface CompactPreview {
  summary: string
  newMessages: Message[]
  summaryTokens: number
  beforeMessageCount: number
  afterMessageCount: number
}

const COMPACT_PROMPT =
  'Please summarise the key context, decisions, and work done in this conversation so far. Be concise but preserve important technical details, file paths, and decisions. This summary will replace the full history to free up context window.'

/**
 * Return the last `turnCount` complete turns.
 *
 * A "turn" starts at a user message and extends through all subsequent
 * assistant/tool messages until the next user message (or end of array).
 * This ensures tool_use/tool_result pairs are never split.
 *
 * If there are fewer than `turnCount` turns, returns all messages.
 */
export function keepLastTurns(messages: Message[], turnCount: number): Message[] {
  if (messages.length === 0) return []
  if (turnCount <= 0) return []

  // Find indices of all user messages (turn boundaries)
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i)
  }

  if (userIndices.length === 0) return messages.slice()
  if (userIndices.length <= turnCount) return messages.slice()

  // Start at the (turnCount)th-from-last user message
  const startIdx = userIndices[userIndices.length - turnCount]
  return messages.slice(startIdx)
}

/**
 * Build a compact preview WITHOUT mutating the caller's message array.
 *
 * Caller decides whether to apply the preview by replacing their message
 * reference with `preview.newMessages`. This enables the /compact UI to show
 * a confirmation before committing.
 */
export async function previewCompact(
  messages: Message[],
  provider: Provider,
  systemPrompt: string,
): Promise<CompactPreview> {
  const beforeMessageCount = messages.length

  const response = await provider.stream(
    [...messages, { role: 'user', content: COMPACT_PROMPT }],
    [],
    { onTextChunk: () => {}, systemPrompt },
  )

  const summary = response.text
  const lastTurns = keepLastTurns(messages, 3)

  const newMessages: Message[] = [
    {
      role: 'user',
      content: `[CONVERSATION SUMMARY]\n${summary}\n[END SUMMARY]\n\nContinuing from above context.`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have the context from the summary. How can I help you continue?',
    },
    ...lastTurns,
  ]

  return {
    summary,
    newMessages,
    summaryTokens: response.usage.outputTokens,
    beforeMessageCount,
    afterMessageCount: newMessages.length,
  }
}

/**
 * Back-compat wrapper around previewCompact returning the legacy CompactResult shape.
 */
export async function compactMessages(
  messages: Message[],
  provider: Provider,
  systemPrompt: string,
): Promise<CompactResult> {
  const preview = await previewCompact(messages, provider, systemPrompt)
  return {
    messages: preview.newMessages,
    summaryTokens: preview.summaryTokens,
    beforeMessageCount: preview.beforeMessageCount,
    afterMessageCount: preview.afterMessageCount,
  }
}
