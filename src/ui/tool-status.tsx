import React from 'react'
import { Text } from 'ink'

interface ToolStatusProps {
  activeTool: { name: string; args: unknown } | null
  lastResult: { name: string; content: string; isError: boolean } | null
}

function truncateArg(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return ''
  // Find the first meaningful string arg
  for (const [, value] of entries) {
    if (typeof value === 'string' && value.trim()) {
      return value.length > 60 ? value.slice(0, 57) + '...' : value
    }
  }
  return ''
}

export function ToolStatus({ activeTool, lastResult }: ToolStatusProps) {
  if (activeTool) {
    const argPreview = truncateArg(activeTool.args)
    return (
      <Text dimColor>
        Running: {activeTool.name}{argPreview ? ` ${argPreview}` : ''}...
      </Text>
    )
  }

  if (lastResult) {
    const preview = lastResult.content.length > 100
      ? lastResult.content.slice(0, 97) + '...'
      : lastResult.content
    return (
      <Text dimColor color={lastResult.isError ? 'red' : undefined}>
        [{lastResult.name}] {preview}
      </Text>
    )
  }

  return null
}
