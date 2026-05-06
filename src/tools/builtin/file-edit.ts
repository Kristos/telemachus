import { z } from 'zod'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '../types.js'

const fileEditSchema = z.object({
  file_path: z.string().describe('Absolute or relative path to the file to edit'),
  old_string: z.string().describe('The exact string to find and replace — must be unique in the file'),
  new_string: z.string().describe('The string to replace it with'),
})

export const fileEditTool: Tool = {
  name: 'file_edit',
  description:
    'Edit a file by replacing an exact string with a new string. ' +
    'The old_string must appear exactly once in the file — fails if not found or if ambiguous (multiple matches). ' +
    'Include surrounding context in old_string to ensure uniqueness.',
  inputSchema: fileEditSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = fileEditSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { file_path, old_string, new_string } = parsed.data
    const resolvedPath = file_path.startsWith('/') ? file_path : join(context.cwd, file_path)

    const bunFile = Bun.file(resolvedPath)
    const exists = await bunFile.exists()
    if (!exists) {
      return { content: `File not found: ${resolvedPath}`, isError: true }
    }

    let content: string
    try {
      content = await bunFile.text()
    } catch (err) {
      return {
        content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    // Count occurrences using indexOf loop — never use regex (old_string may contain special chars)
    let count = 0
    let pos = 0
    while (true) {
      const idx = content.indexOf(old_string, pos)
      if (idx === -1) break
      count++
      pos = idx + old_string.length
    }

    if (count === 0) {
      return {
        content: `old_string not found in ${resolvedPath}`,
        isError: true,
      }
    }

    if (count > 1) {
      return {
        content: `old_string matches ${count} locations in ${resolvedPath} — add more surrounding context to make it unique`,
        isError: true,
      }
    }

    // Exactly one match — plain string replace
    const newContent = content.replace(old_string, new_string)

    try {
      await Bun.write(resolvedPath, newContent)
      return { content: `Edited ${resolvedPath}`, isError: false }
    } catch (err) {
      return {
        content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
