import type { Message } from '../providers/types.js'

/**
 * Returns the index of the first message to keep in the window.
 * Guarantees the kept slice always starts at a 'user' message so
 * tool_use/tool_result pairs are never orphaned.
 *
 * Algorithm:
 * 1. If messages.length <= windowSize, return 0 (keep all)
 * 2. candidate = messages.length - windowSize
 * 3. Walk forward while messages[candidate].role !== 'user' (skip into next safe boundary)
 * 4. If candidate >= messages.length, return 0 (can't safely cut — keep all)
 * 5. Return candidate
 */
export function buildDropPlan(messages: Message[], windowSize: number): number {
  if (messages.length <= windowSize) return 0

  let candidate = messages.length - windowSize

  // Walk forward to the nearest user message — ensures we never start
  // mid tool_use/tool_result sequence
  while (candidate < messages.length && messages[candidate].role !== 'user') {
    candidate++
  }

  // If we walked past the end, we can't safely cut — keep everything
  if (candidate >= messages.length) return 0

  return candidate
}

/**
 * Returns a windowed slice of messages safe to send to the provider.
 * When no windowing is needed (messages.length <= windowSize), returns
 * the original array reference unchanged.
 */
export function applyWindow(messages: Message[], windowSize: number): Message[] {
  const keepFrom = buildDropPlan(messages, windowSize)
  if (keepFrom === 0) return messages
  return messages.slice(keepFrom)
}
