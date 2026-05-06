import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ClaudeJsonMcpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface ClaudeJsonConfig {
  mcpServers?: Record<string, ClaudeJsonMcpServer>
}

/**
 * Reads ~/.claude.json and returns the parsed config.
 * Returns an empty object gracefully if the file is absent or malformed.
 */
export async function readClaudeJson(): Promise<ClaudeJsonConfig> {
  const path = join(homedir(), '.claude.json')
  try {
    const text = await Bun.file(path).text()
    return JSON.parse(text) as ClaudeJsonConfig
  } catch {
    // File absent, unreadable, or malformed — non-fatal
    return {}
  }
}
