/**
 * Slash command parsing for the kc UI.
 *
 * The dispatcher itself is intentionally tiny — `app.tsx` switches on
 * `parseSlashCommand(text).name` and handles each command inline using
 * the formatters from `./format.ts` and `./export-md.ts`.
 *
 * This module is the canonical source of builtin command names so that
 * tab completion in `input.tsx` stays in sync with the dispatch table.
 */

export const BUILTIN_COMMAND_NAMES: readonly string[] = [
  'compact',
  'config',
  'context',
  'model',
  'clear',
  'plan',
  'help',
  'cost',
  'resume',
  'export',
  'mcp',
  'profile',
  'agents',
  'hooks',
] as const

export interface ParsedSlashCommand {
  name: string
  arg: string
}

/**
 * Parse a raw input line into a slash command + arg.
 *
 * - Returns null if the text does not start with `/` or has no command name.
 * - The returned `name` is lowercased; the `arg` is trimmed and may be empty.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  if (rest.length === 0) return null
  const trimmed = rest.trimStart()
  if (trimmed.length === 0) return null

  const spaceIdx = trimmed.search(/\s/)
  if (spaceIdx === -1) {
    return { name: trimmed.toLowerCase(), arg: '' }
  }
  const name = trimmed.slice(0, spaceIdx).toLowerCase()
  const arg = trimmed.slice(spaceIdx + 1).trim()
  return { name, arg }
}
