import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'

const webSearchSchema = z.object({
  query: z.string().describe('The search query'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe('Restrict results to these domains'),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Exclude results from these domains'),
})

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web using Anthropic\'s built-in search capability. ' +
    'Only available when using the Anthropic provider — executed server-side by the API.',
  inputSchema: webSearchSchema,
  isServerTool: true,

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
    throw new Error('web_search is a server-side tool — executed by the Anthropic API, not locally')
  },
}
