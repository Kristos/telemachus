import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'

const askUserQuestionSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  options: z
    .array(z.string())
    .optional()
    .describe('Optional list of answer choices to present to the user'),
})

export const askUserQuestionTool: Tool = {
  name: 'ask_user_question',
  description:
    'Ask the user a question and wait for their answer. ' +
    'Optionally provide a list of choices. The agent loop pauses until the user responds.',
  inputSchema: askUserQuestionSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = askUserQuestionSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { question, options } = parsed.data

    try {
      const answer = await context.askUser(question, options ?? [])
      return {
        content: `User answered: ${answer}`,
        isError: false,
      }
    } catch (err) {
      return {
        content: `Failed to get user response: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}
