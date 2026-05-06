import React, { useState, useEffect, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { Message, ContentBlock } from '../providers/types.js'
import { messageText } from '../providers/types.js'
import { ToolBlock, shouldCollapseByDefault } from './components/ToolBlock.js'
import { registeredCliToolNames } from '../cli-tools/register.js'

function asText(c: Message['content']): string {
  if (c == null) return ''
  if (typeof c === 'string') return c
  return messageText(c)
}

function imageBlocks(c: Message['content']): Array<Extract<ContentBlock, { type: 'image' }>> {
  if (!Array.isArray(c)) return []
  return c.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
}

interface ChatProps {
  messages: Message[]
  collapseThreshold?: number
  /** Incremented by parent on each user submit; triggers focus reset. */
  submitSignal?: number
  /** When true, parent's input area owns Tab (slash completion); chat won't engage Tab. */
  inputHasSlashDraft?: boolean
}

interface ToolBlockDescriptor {
  toolId: string
  toolName: string
  result: string
  durationMs?: number
}

/** Walk messages and produce ordered tool block descriptors paired by toolCallId. */
function extractToolBlocks(messages: Message[]): ToolBlockDescriptor[] {
  const resultsById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultsById.set(m.toolCallId, asText(m.content))
    }
  }
  const blocks: ToolBlockDescriptor[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        const result = resultsById.get(tc.id)
        if (result == null) continue
        blocks.push({
          toolId: tc.id,
          toolName: registeredCliToolNames.has(tc.name) ? `cli:${tc.name}` : tc.name,
          result,
          // durationMs: not currently captured by agent loop; render without ms
        })
      }
    }
  }
  return blocks
}

export function Chat({ messages, collapseThreshold = 10, submitSignal = 0, inputHasSlashDraft = false }: ChatProps) {
  const [focusedToolId, setFocusedToolId] = useState<string | null>(null)
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({})

  const toolBlocks = useMemo(() => extractToolBlocks(messages), [messages])

  // Reset focus when a new user submit fires
  useEffect(() => {
    setFocusedToolId(null)
  }, [submitSignal])

  const isEffectivelyCollapsed = (b: ToolBlockDescriptor): boolean => {
    if (b.toolId in collapsedOverrides) return collapsedOverrides[b.toolId]!
    return shouldCollapseByDefault(b.result, collapseThreshold)
  }

  useInput((input, key) => {
    if (toolBlocks.length === 0) return

    if (key.tab && !key.shift) {
      if (inputHasSlashDraft) return
      const idx = focusedToolId == null ? -1 : toolBlocks.findIndex(b => b.toolId === focusedToolId)
      const next = toolBlocks[(idx + 1) % toolBlocks.length]!
      setFocusedToolId(next.toolId)
      return
    }
    if (key.tab && key.shift) {
      const idx = focusedToolId == null ? 0 : toolBlocks.findIndex(b => b.toolId === focusedToolId)
      const prevIdx = (idx - 1 + toolBlocks.length) % toolBlocks.length
      setFocusedToolId(toolBlocks[prevIdx]!.toolId)
      return
    }
    if (key.return && focusedToolId != null) {
      const b = toolBlocks.find(x => x.toolId === focusedToolId)
      if (!b) return
      const current = isEffectivelyCollapsed(b)
      setCollapsedOverrides(prev => ({ ...prev, [focusedToolId]: !current }))
      return
    }
    if (key.escape) {
      setFocusedToolId(null)
      return
    }
  })

  const displayMessages = messages.filter(m => {
    if (m.role === 'tool') return false
    return true
  })

  if (displayMessages.length === 0 && toolBlocks.length === 0) return null

  // Render messages in order; for assistant tool calls, render ToolBlocks inline
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => {
        if (msg.role === 'tool') return null
        if (msg.role === 'user') {
          const imgs = imageBlocks(msg.content)
          return (
            <Box key={i} flexDirection="column">
              <Text color="cyan">{'> '}{asText(msg.content)}</Text>
              {imgs.map((b, j) => {
                const bytes = Math.floor((b.source.data.length * 3) / 4)
                return (
                  <Text key={j} color="cyan">{`  [📎 image ${b.source.mediaType} (${bytes} bytes)]`}</Text>
                )
              })}
            </Box>
          )
        }
        if (msg.role === 'assistant') {
          const text = asText(msg.content)
          return (
            <Box key={i} flexDirection="column">
              {text ? <Text>{text}</Text> : null}
              {msg.toolCalls?.map(tc => {
                const b = toolBlocks.find(x => x.toolId === tc.id)
                if (!b) {
                  // No matching result yet (still running) — fall back to label
                  return <Text key={tc.id} color="yellow">[Tool: {tc.name}]</Text>
                }
                return (
                  <ToolBlock
                    key={tc.id}
                    toolId={b.toolId}
                    toolName={b.toolName}
                    result={b.result}
                    durationMs={b.durationMs}
                    collapsed={isEffectivelyCollapsed(b)}
                    focused={focusedToolId === b.toolId}
                    onToggle={() => {
                      const current = isEffectivelyCollapsed(b)
                      setCollapsedOverrides(prev => ({ ...prev, [b.toolId]: !current }))
                    }}
                  />
                )
              })}
            </Box>
          )
        }
        return null
      })}
    </Box>
  )
}
