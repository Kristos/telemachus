/**
 * Phase 39: Reviewer agent module.
 *
 * The reviewer reads the worker's diff + summary via its system prompt and
 * emits a typed verdict through the `submit_review` tool. If the reviewer
 * exits without calling the tool, the verdict defaults to 'reject' per REV-02.
 *
 * Design:
 * - `makeSubmitReviewTool()` — factory that creates the submit_review tool and
 *   a closure-based getter for the captured verdict. One instance per review run.
 * - `buildReviewerSystemPrompt()` — constructs the system prompt with diff,
 *   task prompt, worker summary, decisions, and constraints.
 * - `runReviewer()` — wires the above together via runSubagent with a
 *   tool-only registry (read-only: submit_review is the only allowed tool per REV-01).
 */

import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../tools/types.js'
import { ToolRegistry } from '../tools/registry.js'
import { runSubagent, type SubagentParent } from '../agent/subagent.js'
import { addTurn, type UsageSession } from '../usage/tracker.js'
import type { WorkerHandoff } from './types.js'
import type { TaskConfig, OrchestrationRunConfig } from './config-schema.js'

/** Typed verdict produced by the reviewer agent. */
export interface ReviewVerdict {
  verdict: 'approve' | 'reject' | 'redirect'
  feedback: string
}

const submitReviewSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'redirect']),
  feedback: z.string().min(1),
})

/**
 * Factory: creates the submit_review tool and a getter for the captured verdict.
 *
 * The verdict is captured via closure — one call per review run. Calling
 * `getVerdict()` before the tool fires returns null; after a successful tool
 * call it returns the typed ReviewVerdict.
 */
export function makeSubmitReviewTool(): { tool: Tool; getVerdict: () => ReviewVerdict | null } {
  let captured: ReviewVerdict | null = null

  const tool: Tool = {
    name: 'submit_review',
    description:
      'Submit your code review verdict. You MUST call this exactly once with your verdict (approve, reject, or redirect) and feedback explaining your reasoning.',
    inputSchema: submitReviewSchema,
    execute: async (args: unknown, _context: ToolContext): Promise<ToolResult> => {
      const parsed = submitReviewSchema.safeParse(args)
      if (!parsed.success) {
        return {
          content: `Invalid input: ${parsed.error.message}`,
          isError: true,
        }
      }
      captured = { verdict: parsed.data.verdict, feedback: parsed.data.feedback }
      return { content: 'Review submitted.', isError: false }
    },
  }

  return { tool, getVerdict: () => captured }
}

/**
 * Builds the reviewer's system prompt.
 *
 * Includes: task instructions, worker summary, decisions made, constraints
 * encountered, and the full git diff (REV-01 — diff must be in system prompt).
 */
function buildReviewerSystemPrompt(handoff: WorkerHandoff, task: TaskConfig): string {
  const decisions = handoff.decisions.join('\n') || 'None'
  const constraints = handoff.constraints_encountered.join('\n') || 'None'

  return `You are a code reviewer. Review the following changes against the task requirements.

Call submit_review with your verdict:
- "approve" if the changes correctly implement the task
- "reject" if the changes are fundamentally wrong or harmful
- "redirect" if the changes need specific improvements (provide actionable feedback)

TASK:
${task.prompt}

WORKER SUMMARY:
${handoff.summary}

DECISIONS MADE:
${decisions}

CONSTRAINTS ENCOUNTERED:
${constraints}

CHANGES:
\`\`\`diff
${handoff.gitDiff}
\`\`\`

You MUST call submit_review exactly once.`
}

/**
 * Run the reviewer agent for a given worker handoff.
 *
 * The reviewer is given a fresh ToolRegistry with ONLY the submit_review tool
 * (REV-01: read-only — no other tools). It has a capped turn budget (5 turns
 * max — the reviewer should decide quickly).
 *
 * If the reviewer exits without calling submit_review, the verdict defaults to
 * 'reject' with feedback referencing REV-02 (REV-02: freetext → reject).
 *
 * @returns Verdict + updated UsageSession (immutable — caller must replace the session).
 */
export async function runReviewer(
  handoff: WorkerHandoff,
  task: TaskConfig,
  _runConfig: OrchestrationRunConfig,
  parent: SubagentParent,
  reviewerSession: UsageSession,
): Promise<{ verdict: ReviewVerdict; session: UsageSession }> {
  const { tool, getVerdict } = makeSubmitReviewTool()

  // REV-01: reviewer gets only submit_review — no filesystem, bash, or other tools.
  const reviewerRegistry = new ToolRegistry()
  reviewerRegistry.register(tool)

  const systemPrompt = buildReviewerSystemPrompt(handoff, task)

  // Reviewer defaults to Opus for high-quality judgment; per-task model override applies.
  const reviewerModel = task.model ?? 'claude-opus-4-5'

  let currentSession = reviewerSession

  // MODE-01: when task has explicit provider (e.g., --cheap → openai-compat/glm),
  // override parent.provider so reviewer API calls use the correct backend.
  let providerOverride: import('../providers/types.js').Provider | undefined
  if (task.provider) {
    const { createProvider } = await import('../providers/registry.js')
    const { loadConfig } = await import('../config/loader.js')
    const kcConfig = await loadConfig(process.cwd())
    providerOverride = createProvider({
      ...kcConfig,
      provider: task.provider,
      model: task.model ?? reviewerModel,
    })
  }

  await runSubagent(
    parent,
    'Review the changes and call submit_review.',
    {
      systemPrompt,
      registry: reviewerRegistry,
      apiSchemas: reviewerRegistry.toAPISchema(),
      maxIterations: 5,
      provider: providerOverride,
      onTurnComplete: (usage) => {
        currentSession = addTurn(currentSession, usage, reviewerModel)
      },
    },
  )

  const verdict = getVerdict()

  if (verdict === null) {
    // REV-02: reviewer exited without calling submit_review — treat as reject.
    return {
      verdict: {
        verdict: 'reject',
        feedback: 'Reviewer did not call submit_review — treated as rejection per REV-02',
      },
      session: currentSession,
    }
  }

  return { verdict, session: currentSession }
}
