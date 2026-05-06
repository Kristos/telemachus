import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../tools/types.js'
import type { CliToolConfig } from '../config/types.js'
import { executeCliTool } from './dispatch.js'

const MAX_DESCRIPTION_LEN = 200

/**
 * Phase 20 (LEAN-02), decision 2: build a model-visible Tool for a configured
 * CLI entry. Each CLI tool gets a minimal `{ args: string }` schema targeting
 * ~30 tokens of schema cost — lean by default.
 *
 * The execute() method is intentionally a stub that throws — plan 03 replaces
 * it with the real spawn + sandbox + audit dispatch. Separating surface (this
 * factory) from dispatch keeps each plan narrowly scoped.
 */
export function buildCliTool(name: string, config: CliToolConfig): Tool {
  const description =
    config.description.length > MAX_DESCRIPTION_LEN
      ? config.description.slice(0, MAX_DESCRIPTION_LEN - 1) + '…'
      : config.description

  const rawInputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      args: { type: 'string' },
    },
    required: ['args'],
  }

  const inputSchema = z.object({ args: z.string() })

  return {
    name,
    description,
    inputSchema,
    rawInputSchema,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(args)
      if (!parsed.success) {
        return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
      }
      return executeCliTool(name, config, parsed.data.args, ctx)
    },
  }
}
