import { z } from 'zod'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Tool, ToolContext, ToolResult } from '../types.js'

const todoItemSchema = z.object({
  id: z.string().describe('Unique identifier for the todo item'),
  content: z.string().describe('The todo item description'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('Current status'),
})

const todoWriteSchema = z.object({
  todos: z.array(todoItemSchema).describe('The complete list of todos to write'),
})

/**
 * SAND-01 (Phase 62, BACKLOG 999.14): resolve todo data dir via os.homedir().
 *
 * Production session logs showed 17 consecutive mkdir '/.telemachus'
 * EROFS failures when context.cwd resolved to filesystem root. os.homedir()
 * reads the passwd entry when env is stripped, making it resilient against
 * launchd plist HOME stripping. Guard surfaces a descriptive error instead
 * of silently attempting to write to '/'.
 */
function resolveTodoRoot(): string {
  const home = homedir()
  if (!home || home === '/') {
    const rendered = home === '' ? 'empty string' : `'${home}'`
    throw new Error(
      `todo_write: os.homedir() returned ${rendered} — cannot resolve ~/.telemachus/todos.json. Check process environment (HOME + passwd entry). See SAND-01 / BACKLOG 999.14.`,
    )
  }
  return join(home, '.telemachus')
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Write a structured todo list to disk. Replaces the existing todo list with the provided items. ' +
    'Todos are saved to ~/.telemachus/todos.json (resolved via os.homedir()).',
  inputSchema: todoWriteSchema,

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    const parsed = todoWriteSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { todos } = parsed.data

    try {
      const todoDir = resolveTodoRoot()
      const todoPath = join(todoDir, 'todos.json')
      await mkdir(todoDir, { recursive: true })
      await Bun.write(todoPath, JSON.stringify(todos, null, 2))
      return {
        content: `Written ${todos.length} todos to ${todoPath}`,
        isError: false,
      }
    } catch (err) {
      return {
        content: `Failed to write todos: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
