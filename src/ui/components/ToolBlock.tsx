// ToolBlock — controlled collapsible tool-use/tool-result block.
//
// Focus style choice: '›' prefix marker (text-based, not reverse-video).
// Rationale: works across terminals without ANSI quirks, easy to assert in
// ink-testing-library frame snapshots, and visually unobtrusive.
//
// This component is presentational. All state (collapsed/focused) is owned
// by the parent (chat.tsx). Keyboard handling lives in the parent's useInput.
import React from 'react'
import { Box, Text } from 'ink'

export interface ToolBlockProps {
  toolId: string
  toolName: string
  args?: unknown
  result: string
  durationMs?: number
  collapsed: boolean
  focused: boolean
  onToggle: (toolId: string) => void
}

/** Count logical lines, ignoring trailing whitespace-only lines. Min 1. */
export function countLines(text: string): number {
  if (text === '') return 1
  const parts = text.split('\n')
  // Drop trailing empty/whitespace-only entries
  let end = parts.length
  while (end > 0 && parts[end - 1]!.trim() === '') end--
  return Math.max(1, end)
}

export function shouldCollapseByDefault(text: string, threshold: number): boolean {
  return countLines(text) > threshold
}

function formatSummary(name: string, lines: number, durationMs?: number): string {
  const dur = durationMs != null ? `, ${durationMs}ms` : ''
  return `Tool: ${name} (${lines} lines${dur})`
}

export const ToolBlock = React.memo(function ToolBlock(props: ToolBlockProps) {
  const { toolName, result, durationMs, collapsed, focused } = props
  const lines = countLines(result)
  const marker = focused ? '› ' : '  '

  if (collapsed) {
    return (
      <Box>
        <Text dimColor={!focused} bold={focused}>
          {marker}▸ {formatSummary(toolName, lines, durationMs)}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold={focused}>
        {marker}▾ Tool: {toolName}
      </Text>
      <Box paddingLeft={2}>
        <Text dimColor>{result}</Text>
      </Box>
    </Box>
  )
})
