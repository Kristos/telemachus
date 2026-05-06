export const MAX_LENGTH = 2000

/**
 * Split a Discord message into chunks of at most MAX_LENGTH (2000) characters.
 *
 * Splitting prefers the last newline boundary within the first 2000 chars.
 * Falls back to a hard split at exactly 2000 chars if no newline is found.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining)
      break
    }

    const slice = remaining.slice(0, MAX_LENGTH)
    const lastNewline = slice.lastIndexOf('\n')
    const splitAt = lastNewline > 0 ? lastNewline + 1 : MAX_LENGTH

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  return chunks
}
