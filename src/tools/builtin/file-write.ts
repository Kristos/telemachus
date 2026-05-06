import { z } from 'zod'
import { join, dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Tool, ToolContext, ToolResult } from '../types.js'

const fileWriteSchema = z.object({
  file_path: z.string().describe('Absolute or relative path to write to'),
  content: z.string().describe('Content to write to the file'),
})

export const fileWriteTool: Tool = {
  name: 'file_write',
  description:
    'Write content to a file on the filesystem. Creates parent directories if they do not exist. ' +
    'Overwrites existing file if present.',
  inputSchema: fileWriteSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = fileWriteSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { file_path, content } = parsed.data
    const resolvedPath = file_path.startsWith('/') ? file_path : join(context.cwd, file_path)

    try {
      await mkdir(dirname(resolvedPath), { recursive: true })
      await Bun.write(resolvedPath, content)
      return {
        content: `Written ${content.length} bytes to ${resolvedPath}`,
        isError: false,
      }
    } catch (err) {
      return {
        content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
