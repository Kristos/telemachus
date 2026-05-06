import type { Message } from '../providers/types.js'

// Discriminated union for JSONL lines
export type MetaEntry = {
  type: 'meta'
  id: string
  startedAt: string  // ISO 8601
  cwd: string
  model: string
}

export type MsgEntry = {
  type: 'msg'
  message: Message
}

export type UsageEntry = {
  type: 'usage'
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
}

export type SessionEntry = MetaEntry | MsgEntry | UsageEntry

// Used by picker and resume summary display
export interface SessionSummary {
  id: string
  startedAt: string   // ISO 8601 from meta entry
  cwd: string
  model: string
  messageCount: number  // count of MsgEntry lines
  totalCostUsd: number  // from UsageEntry, or 0 if missing
  inputTokens: number
  outputTokens: number
}
