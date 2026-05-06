import { z } from 'zod'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { truncateResult } from '../../utils/truncate.js'

const fileReadSchema = z.object({
  file_path: z.string().describe('Absolute or relative path to the file to read'),
  offset: z.number().int().min(0).optional().describe('Line number to start reading from (1-based)'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to read'),
})

export const fileReadTool: Tool = {
  name: 'file_read',
  description:
    'Read a file from the filesystem. Returns file contents with line numbers. ' +
    'Use offset and limit to read specific line ranges.',
  inputSchema: fileReadSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = fileReadSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { file_path, offset, limit } = parsed.data
    const resolvedPath = file_path.startsWith('/') ? file_path : join(context.cwd, file_path)

    const bunFile = Bun.file(resolvedPath)
    const exists = await bunFile.exists()
    if (!exists) {
      return { content: `File not found: ${resolvedPath}`, isError: true }
    }

    let text: string
    try {
      text = await bunFile.text()
    } catch (err) {
      return {
        content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    const allLines = text.split('\n')
    const startIndex = offset !== undefined ? offset - 1 : 0  // convert 1-based to 0-based
    const endIndex = limit !== undefined ? startIndex + limit : allLines.length

    const lines = allLines.slice(Math.max(0, startIndex), endIndex)
    const startLineNumber = Math.max(1, startIndex + 1)

    const numbered = lines
      .map((line, i) => `${startLineNumber + i}\t${line}`)
      .join('\n')

    return {
      content: truncateResult(numbered),
      isError: false,
    }
  },
}
