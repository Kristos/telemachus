import type { ClaudeJsonConfig } from '../config/mcp-config'

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookCommand {
  type: 'command'
  command: string
  timeout?: number
}

export interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>

export interface ClaudeJsonWithHooks extends ClaudeJsonConfig {
  hooks?: HookConfig
}
