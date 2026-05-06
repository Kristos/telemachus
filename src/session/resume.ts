import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { basename, dirname } from 'path'
import { listSessions, loadSession } from './store.js'
import type { SessionSummary, MetaEntry, UsageEntry, MsgEntry } from './types.js'

export async function loadSessionSummaries(limit = 10): Promise<SessionSummary[]> {
  const ids = await listSessions()
  const slice = ids.slice(0, limit)

  const results = await Promise.all(
    slice.map(async (id) => {
      try {
        const entries = await loadSession(id)
        const meta = entries.find((e): e is MetaEntry => e.type === 'meta')
        if (!meta) return null  // corrupt — skip

        const msgCount = entries.filter((e): e is MsgEntry => e.type === 'msg').length
        const usageEntries = entries.filter((e): e is UsageEntry => e.type === 'usage')
        const usage = usageEntries.length > 0 ? usageEntries[usageEntries.length - 1] : undefined

        const summary: SessionSummary = {
          id: meta.id,
          startedAt: meta.startedAt,
          cwd: meta.cwd,
          model: meta.model,
          messageCount: msgCount,
          totalCostUsd: usage?.totalCostUsd ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        }
        return summary
      } catch {
        return null
      }
    })
  )

  return results.filter((s): s is SessionSummary => s !== null)
}

interface SessionPickerProps {
  summaries: SessionSummary[]
  onSelect: (summary: SessionSummary) => void
  onCancel?: () => void
}

export function SessionPicker({ summaries, onSelect, onCancel }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    if (summaries.length === 0 && !onCancel) process.exit(0)
  }, [summaries.length, onCancel])

  useInput((input, key) => {
    if (key.upArrow)   setCursor(c => Math.max(0, c - 1))
    if (key.downArrow) setCursor(c => Math.min(summaries.length - 1, c + 1))
    if (key.return && summaries.length > 0) onSelect(summaries[cursor])
    if (input === 'q' || key.escape) {
      if (onCancel) onCancel()
      else process.exit(0)
    }
  })

  if (summaries.length === 0) {
    return React.createElement(Text, { color: 'yellow' }, 'No sessions found.')
  }

  const shortCwd = (cwd: string) => {
    const parent = basename(dirname(cwd))
    const base = basename(cwd)
    return `${parent}/${base}`
  }

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'Resume session (\u2191\u2193 select, Enter confirm, q quit)'),
    ...summaries.map((s, i) => {
      const date = new Date(s.startedAt).toLocaleString()
      const cost = `$${s.totalCostUsd.toFixed(4)}`
      const cwd = shortCwd(s.cwd)
      const line = `${date} \u2014 ${s.messageCount} msgs \u2014 ${cost} \u2014 ${cwd}`
      const selected = i === cursor

      return React.createElement(
        Text,
        { key: s.id, bold: selected, dimColor: !selected },
        `${selected ? '>' : ' '} ${line}`
      )
    })
  )
}
