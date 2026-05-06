import React from 'react'
import { Box, Text } from 'ink'
import type { UsageSession } from '../usage/tracker.js'
import { getContextLimit } from '../usage/pricing.js'
import type { PermissionMode } from '../permissions/types.js'

export interface StatusBarProps {
  session: UsageSession
  model: string
  providerName: string
  permissionMode: PermissionMode
  subagentActive?: boolean
  fallbackActive?: boolean
}

function formatTokens(n: number, estimated: boolean): string {
  const prefix = estimated ? '~' : ''
  if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1)}k`
  return `${prefix}${n}`
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.001) return `$${usd.toFixed(5)}`
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

function contextBar(pct: number, width = 10): string {
  const filled = Math.round(pct * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function contextColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 0.9) return 'red'
  if (pct >= 0.75) return 'yellow'
  return 'green'
}

export function StatusBar({ session, model, providerName, permissionMode, subagentActive, fallbackActive }: StatusBarProps) {
  const { lastTurn, totalCost } = session

  const contextLimit = getContextLimit(model)
  const contextTokens = lastTurn?.inputTokens ?? 0
  const contextPct = contextLimit > 0 ? Math.min(contextTokens / contextLimit, 1) : 0
  const pctDisplay = (contextPct * 100).toFixed(0)
  const barColor = contextColor(contextPct)
  const estimated = lastTurn?.isEstimated ?? false

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      {/* Context fill */}
      <Text color={barColor}>
        ctx {pctDisplay}% [{contextBar(contextPct)}]
      </Text>
      <Text dimColor>  |  </Text>

      {/* Turn tokens */}
      {lastTurn ? (
        <>
          <Text dimColor>
            turn {formatTokens(lastTurn.inputTokens, estimated)}↑ {formatTokens(lastTurn.outputTokens, false)}↓
          </Text>
          <Text dimColor>  |  </Text>
          <Text dimColor>turn {formatCost(lastTurn.cost)}</Text>
          <Text dimColor>  |  </Text>
        </>
      ) : (
        <>
          <Text dimColor>turn —</Text>
          <Text dimColor>  |  </Text>
        </>
      )}

      {/* Session cost */}
      <Text>session {formatCost(totalCost)}</Text>

      {/* Model name (right-aligned feel) */}
      <Text dimColor>  |  {providerName}/{model}</Text>

      {/* Permission mode — only shown when not yolo (default) */}
      {permissionMode !== 'yolo' && (
        <>
          <Text dimColor>  |  </Text>
          <Text color={
            permissionMode === 'readonly' ? 'red' :
            permissionMode === 'plan' ? 'cyan' :
            'yellow'
          }>{permissionMode}</Text>
        </>
      )}

      {/* Subagent activity indicator — visible while a task-tool subagent is running */}
      {subagentActive && (
        <>
          <Text dimColor>  |  </Text>
          <Text color="cyan">subagent…</Text>
        </>
      )}

      {/* Fallback indicator — visible when FallbackProvider is using non-primary provider */}
      {fallbackActive && (
        <>
          <Text dimColor>  |  </Text>
          <Text color="yellow">[fallback]</Text>
        </>
      )}
    </Box>
  )
}
