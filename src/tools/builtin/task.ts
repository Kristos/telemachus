import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { runSubagent } from '../../agent/subagent.js'

const taskSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(200)
    .describe('Short one-line summary of the sub-task (used for UI display)'),
  prompt: z
    .string()
    .min(1)
    .describe('The full instruction sent to the subagent'),
  subagent_type: z
    .string()
    .optional()
    .describe('Optional subagent type hint (informational in v1 — only general-purpose subagent ships)'),
})

export const taskTool: Tool = {
  name: 'task',
  description:
    'Spawn a fresh subagent with its own context window to handle a focused sub-task. ' +
    'Use this when delegating research or multi-step work that would otherwise bloat the main conversation. ' +
    'The subagent inherits the parent provider, tools, and permission gate, but runs on an isolated message array. ' +
    'Returns the subagent\'s final assistant text as the tool result.',
  inputSchema: taskSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = taskSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { description, prompt, subagent_type } = parsed.data

    if (!context.subagentParent) {
      return {
        content:
          'task tool requires subagentParent in ToolContext (parent loop did not wire it)',
        isError: true,
      }
    }

    // subagent_type currently informational — log for forward-compat with future routing
    if (subagent_type) {
      // eslint-disable-next-line no-console
      console.error(`[task] description=${description} subagent_type=${subagent_type}`)
    }

    context.onSubagentStart?.()
    let result
    try {
      result = await runSubagent(context.subagentParent, prompt)
    } finally {
      context.onSubagentEnd?.()
    }

    if (result.error) {
      return {
        content: `Subagent failed: ${result.error.message}`,
        isError: true,
      }
    }

    if (!result.text) {
      return { content: '(subagent returned no text)', isError: false }
    }

    return { content: result.text, isError: false }
  },
}
