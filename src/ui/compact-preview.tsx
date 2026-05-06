import React from 'react'
import { Box, Text, useInput } from 'ink'

interface CompactPreviewProps {
  summary: string
  beforeCount: number
  afterCount: number
  summaryTokens: number
  auto?: boolean
  onAccept: () => void
  onCancel: () => void
}

const MAX_DISPLAY_LINES = 40

export function CompactPreview({
  summary,
  beforeCount,
  afterCount,
  summaryTokens,
  auto = false,
  onAccept,
  onCancel,
}: CompactPreviewProps) {
  useInput((_input, key) => {
    if (key.return) onAccept()
    else if (key.escape) onCancel()
  })

  const lines = summary.split('\n')
  const truncated = lines.length > MAX_DISPLAY_LINES
  const displayLines = truncated ? lines.slice(0, MAX_DISPLAY_LINES) : lines
  const hiddenCount = lines.length - MAX_DISPLAY_LINES

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Compact preview{auto ? ' (auto)' : ''}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {displayLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        {truncated ? (
          <Text dimColor>... {hiddenCount} more lines (will be saved in full)</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {beforeCount} → {afterCount} messages · ~{summaryTokens} summary tokens
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter accept · Esc cancel</Text>
      </Box>
    </Box>
  )
}
