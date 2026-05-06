import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { truncateResult } from '../../utils/truncate.js'

const webFetchSchema = z.object({
  url: z.string().url().describe('The URL to fetch'),
  prompt: z
    .string()
    .optional()
    .describe('What to extract from the page (for context — the tool returns full content)'),
})

const FETCH_TIMEOUT_MS = 30_000
const MAX_RAW_CHARS = 100_000

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its content. HTML pages are converted to Markdown for readability. ' +
    'Content is truncated at 5000 chars. Optionally provide a prompt describing what to extract.',
  inputSchema: webFetchSchema,

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    const parsed = webFetchSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { url, prompt } = parsed.data

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)

      if (!response.ok) {
        return {
          content: `HTTP error ${response.status}: ${response.statusText}`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      let content: string

      if (contentType.includes('text/html')) {
        const html = (await response.text()).slice(0, MAX_RAW_CHARS)
        // Lazy import for CJS interop in Bun
        const m = await import('turndown')
        const TurndownService = (m as unknown as { default: new () => { turndown(html: string): string } }).default || m
        const td = new TurndownService()
        content = td.turndown(html)
      } else {
        content = (await response.text()).slice(0, MAX_RAW_CHARS)
      }

      const header = prompt ? `[Fetching: ${url}]\n[Looking for: ${prompt}]\n\n` : `[Fetched: ${url}]\n\n`
      return {
        content: truncateResult(header + content),
        isError: false,
      }
    } catch (err) {
      clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('abort') || msg.includes('AbortError')) {
        return { content: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`, isError: true }
      }
      return { content: `Failed to fetch ${url}: ${msg}`, isError: true }
    }
  },
}
