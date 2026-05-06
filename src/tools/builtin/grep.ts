import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { truncateResult } from '../../utils/truncate.js'

const grepSchema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  path: z.string().optional().default('.').describe('File or directory to search in'),
  include: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "**/*.tsx")'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .default('files_with_matches')
    .describe('Output mode: content (matching lines), files_with_matches (file paths), count (match counts)'),
})

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search for patterns in files using ripgrep. ' +
    'Supports regex patterns, file filtering with glob, and multiple output modes.',
  inputSchema: grepSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = grepSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { pattern, path, include, output_mode } = parsed.data

    const rgArgs: string[] = ['rg']

    if (output_mode === 'files_with_matches') {
      rgArgs.push('-l')
    } else if (output_mode === 'count') {
      rgArgs.push('-c')
    }
    // 'content' mode uses no flags — shows matching lines by default

    if (include) {
      rgArgs.push('--glob', include)
    }

    rgArgs.push(pattern, path)

    try {
      const proc = Bun.spawn(rgArgs, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: context.cwd,
      })

      await proc.exited

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      const exitCode = proc.exitCode ?? 0

      if (exitCode === 0) {
        return { content: truncateResult(stdout.trim()), isError: false }
      } else if (exitCode === 1) {
        // rg exit code 1 means no matches — not an error
        return { content: 'No matches found', isError: false }
      } else {
        // exit code 2+ means actual error
        const errMsg = stderr.trim() || `rg exited with code ${exitCode}`
        return { content: errMsg, isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT') || msg.toLowerCase().includes('not found')) {
        return { content: 'rg (ripgrep) not found — install ripgrep to use the grep tool', isError: true }
      }
      return { content: `Failed to run rg: ${msg}`, isError: true }
    }
  },
}
