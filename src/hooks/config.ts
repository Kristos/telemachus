import { readClaudeJson, type ClaudeJsonConfig } from '../config/mcp-config'
import type { HookConfig, HookEvent, HookCommand, HookMatcher } from './types'

type Reader = () => Promise<ClaudeJsonConfig>

/**
 * Loads the `hooks` block from ~/.claude.json.
 * Returns {} on any error or missing data — never throws.
 */
export async function loadHooks(reader: Reader = readClaudeJson): Promise<HookConfig> {
  try {
    const json = (await reader()) as ClaudeJsonConfig & { hooks?: HookConfig }
    return json?.hooks ?? {}
  } catch {
    return {}
  }
}

/**
 * Returns the flattened HookCommand[] for a given (event, toolName).
 * - Stop ignores matcher: returns all hooks for the event.
 * - Empty matcher string matches any tool.
 * - Invalid regex matchers are skipped silently.
 */
export function matchHooks(
  event: HookEvent,
  toolName: string,
  config: HookConfig,
): HookCommand[] {
  const entries: HookMatcher[] = config[event] ?? []
  const out: HookCommand[] = []

  for (const entry of entries) {
    if (event === 'Stop') {
      out.push(...entry.hooks)
      continue
    }
    const matcher = entry.matcher ?? ''
    if (matcher === '' || matcher === '*') {
      out.push(...entry.hooks)
      continue
    }
    let re: RegExp
    try {
      re = new RegExp(matcher)
    } catch {
      continue
    }
    if (re.test(toolName)) {
      out.push(...entry.hooks)
    }
  }

  return out
}
