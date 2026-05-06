export function truncateResult(text: string, maxChars = 5_000): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.7)
  const tailChars = maxChars - headChars
  return (
    text.slice(0, headChars) +
    `\n\n... [truncated ${text.length - maxChars} chars] ...\n\n` +
    text.slice(text.length - tailChars)
  )
}
