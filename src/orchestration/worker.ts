/**
 * Phase 39: Worker agent module.
 *
 * Implements the first half of the worker-reviewer loop. The worker:
 * 1. Creates an isolated git worktree branch for the task attempt
 * 2. Runs a subagent with a restricted tool set + submit_handoff tool
 * 3. Auto-commits any uncommitted changes in the worktree
 * 4. Extracts the git diff and returns a structured WorkerHandoff
 *
 * Exports:
 *   runWorker         — main entry point
 *   cleanupWorkerBranch — remove worktree + branch (on rejection/failure)
 *   mergeWorkerBranch   — merge approved worker branch back to repo root
 */

import { z } from 'zod'
import { runSubagent, type SubagentParent } from '../agent/subagent.js'
import { ToolRegistry } from '../tools/registry.js'
import type { Tool, ToolResult } from '../tools/types.js'
import type { TaskConfig, OrchestrationRunConfig } from './config-schema.js'
import type { WorkerHandoff, RetryHistoryEntry } from './types.js'
import { runGit } from './git.js'
import { runDir } from './event-log.js'
import { addTurn, type UsageSession } from '../usage/tracker.js'

// ---------------------------------------------------------------------------
// submit_handoff tool
// ---------------------------------------------------------------------------

const submitHandoffSchema = z.object({
  summary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  constraints_encountered: z.array(z.string()).default([]),
})

type RawHandoff = z.infer<typeof submitHandoffSchema>

/**
 * Factory that creates a submit_handoff tool and a getter for the captured data.
 * The worker calls this tool when it has finished its work.
 */
export function makeSubmitHandoffTool(): { tool: Tool; getHandoff: () => RawHandoff | null } {
  let captured: RawHandoff | null = null

  const tool: Tool = {
    name: 'submit_handoff',
    description:
      'Submit your work handoff when you have completed the task. ' +
      'Provide a summary of what you did, any decisions you made, and any constraints you encountered.',
    inputSchema: submitHandoffSchema,
    async execute(args: unknown): Promise<ToolResult> {
      const parsed = submitHandoffSchema.safeParse(args)
      if (!parsed.success) {
        return { content: `Invalid handoff arguments: ${parsed.error.message}`, isError: true }
      }
      captured = parsed.data
      return { content: 'Handoff submitted.', isError: false }
    },
  }

  return { tool, getHandoff: () => captured }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the worker agent.
 * If retryHistory is non-empty, prior attempt summaries and reviewer feedback
 * are appended so the worker can learn from previous attempts.
 *
 * Phase 56 (POOL-01): optional staticContext is prepended with an Anthropic
 * cache-control breakpoint marker. For non-Anthropic providers the tag is
 * harmless decorative text; actual provider-level cache_control wiring is a
 * future plan. Existing callers with no third argument are unaffected.
 */
export function buildWorkerSystemPrompt(
  task: TaskConfig,
  retryHistory: readonly RetryHistoryEntry[],
  staticContext?: string,
): string {
  let prompt = ''

  if (staticContext && staticContext.length > 0) {
    prompt += `<static_context cache="ephemeral">\n${staticContext}\n</static_context>\n\n`
  }

  prompt +=
    `You are a code worker agent. Complete the task below. When done, call the submit_handoff tool with a summary of what you did, any decisions you made, and any constraints you encountered.\n\nTASK:\n${task.prompt}\n\nYou MUST call submit_handoff when your work is complete.`

  if (retryHistory.length > 0) {
    prompt += '\n\nPRIOR ATTEMPTS:'
    for (const entry of retryHistory) {
      prompt += `\nAttempt ${entry.attemptNumber}: ${entry.summary}\nReviewer feedback: ${entry.reviewerFeedback}`
    }
  }

  return prompt
}

// ---------------------------------------------------------------------------
// runWorker
// ---------------------------------------------------------------------------

/**
 * Run the worker agent for a single task attempt.
 *
 * Creates an isolated git worktree, runs the subagent with restricted tools
 * + submit_handoff, auto-commits uncommitted changes, extracts the git diff,
 * and returns a structured WorkerHandoff (or an error if the worker failed
 * to call submit_handoff or made no git changes).
 */
export async function runWorker(
  taskId: string,
  runId: string,
  task: TaskConfig,
  runConfig: OrchestrationRunConfig,
  attemptNumber: number,
  retryHistory: readonly RetryHistoryEntry[],
  parent: SubagentParent,
  workerSession: UsageSession,
): Promise<{ handoff: WorkerHandoff | null; session: UsageSession; error: string | null }> {
  const repoRoot = parent.toolContext.cwd
  const branchName = `orchestration/${runId}/${taskId}/attempt-${attemptNumber}`
  const worktreePath = `${runDir(runId)}/tasks/${taskId}/attempt-${attemptNumber}/worktree`

  // ------------------------------------------------------------------
  // 1. Create the worktree (handle stale branch from previous crash)
  // ------------------------------------------------------------------
  let worktreeResult = await runGit(
    ['worktree', 'add', '-b', branchName, worktreePath],
    repoRoot,
    30_000,
  )
  if (worktreeResult.exitCode !== 0) {
    // Stale branch? Try deleting it then retrying.
    const branchExists =
      worktreeResult.stderr.includes('already exists') ||
      worktreeResult.stderr.includes('already checked out')
    if (branchExists) {
      await runGit(['branch', '-D', branchName], repoRoot, 10_000)
      worktreeResult = await runGit(
        ['worktree', 'add', '-b', branchName, worktreePath],
        repoRoot,
        30_000,
      )
    }
    if (worktreeResult.exitCode !== 0) {
      return {
        handoff: null,
        session: workerSession,
        error: `Failed to create worktree: ${worktreeResult.stderr.trim()}`,
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Build restricted tool registry
  // ------------------------------------------------------------------
  const { tool: submitHandoffTool, getHandoff } = makeSubmitHandoffTool()

  const filteredRegistry = new ToolRegistry()
  const allTools = parent.registry.getAll()
  const toolsToRegister = task.allowedTools
    ? allTools.filter((t) => task.allowedTools!.includes(t.name))
    : allTools
  filteredRegistry.registerAll(toolsToRegister)
  filteredRegistry.register(submitHandoffTool)

  // ------------------------------------------------------------------
  // 3. Modified ToolContext pointing at the worktree
  // ------------------------------------------------------------------
  const workerToolContext = {
    ...parent.toolContext,
    cwd: worktreePath,
  }

  // ------------------------------------------------------------------
  // 4. Build worker parent
  // ------------------------------------------------------------------
  const effectiveMaxWorkerTurns = task.maxWorkerTurns ?? runConfig.maxWorkerTurns

  const workerParent: SubagentParent = {
    ...parent,
    registry: filteredRegistry,
    toolContext: workerToolContext,
  }

  // ------------------------------------------------------------------
  // 5. Run subagent
  // ------------------------------------------------------------------
  let mutableSession = workerSession
  const systemPrompt = buildWorkerSystemPrompt(task, retryHistory, parent.staticContext)

  await runSubagent(
    workerParent,
    task.prompt,
    {
      systemPrompt,
      maxIterations: effectiveMaxWorkerTurns,
      registry: filteredRegistry,
      apiSchemas: filteredRegistry.toAPISchema(),
      onTurnComplete: (usage) => {
        mutableSession = addTurn(mutableSession, usage, task.model ?? 'glm-4')
      },
    },
  )

  // ------------------------------------------------------------------
  // 6. Check submit_handoff was called
  // ------------------------------------------------------------------
  const rawHandoff = getHandoff()
  if (rawHandoff === null) {
    return {
      handoff: null,
      session: mutableSession,
      error: 'Worker did not call submit_handoff',
    }
  }

  // ------------------------------------------------------------------
  // 7. Check for git changes
  // ------------------------------------------------------------------
  const statusResult = await runGit(['status', '--porcelain'], worktreePath, 10_000)
  const hasUncommittedChanges = statusResult.stdout.trim().length > 0

  // Check if there are any commits at all beyond the initial one
  const logResult = await runGit(['log', '--oneline'], worktreePath, 10_000)
  const commitCount = logResult.stdout.trim().split('\n').filter((l) => l.trim().length > 0).length

  // If no uncommitted changes and only 1 commit (the initial branch point), no work was done
  if (!hasUncommittedChanges && commitCount <= 1) {
    // Verify this isn't the case where the initial branch has no work
    // Check if there's any diff vs the base
    const diffCheck = await runGit(['diff', 'HEAD~1..HEAD', '--stat'], worktreePath, 10_000)
    if (diffCheck.stdout.trim().length === 0 || diffCheck.exitCode !== 0) {
      return {
        handoff: null,
        session: mutableSession,
        error: 'Worker made no git changes',
      }
    }
  }

  // ------------------------------------------------------------------
  // 8. Auto-commit uncommitted changes if any
  // ------------------------------------------------------------------
  if (hasUncommittedChanges) {
    await runGit(['add', '-A'], worktreePath, 10_000)
    await runGit(
      ['commit', '-m', `orchestration: worker attempt ${attemptNumber}`],
      worktreePath,
      10_000,
    )
  }

  // ------------------------------------------------------------------
  // 9. Get git diff
  // ------------------------------------------------------------------
  let diffResult = await runGit(['diff', 'HEAD^', 'HEAD'], worktreePath, 30_000)
  if (diffResult.stdout.trim().length === 0 || diffResult.exitCode !== 0) {
    // Fallback for single-commit worktree: show the full HEAD diff
    diffResult = await runGit(
      ['show', '--format=', '--patch', 'HEAD'],
      worktreePath,
      30_000,
    )
  }

  // ------------------------------------------------------------------
  // 10. Build and return WorkerHandoff
  // ------------------------------------------------------------------
  const handoff: WorkerHandoff = {
    taskId,
    runId,
    attemptNumber,
    branchName,
    worktreePath,
    gitDiff: diffResult.stdout,
    summary: rawHandoff.summary,
    decisions: rawHandoff.decisions,
    constraints_encountered: rawHandoff.constraints_encountered,
  }

  return { handoff, session: mutableSession, error: null }
}

// ---------------------------------------------------------------------------
// cleanupWorkerBranch
// ---------------------------------------------------------------------------

/**
 * Remove the worker worktree and delete the branch.
 * Called on rejection or failure — errors go to stderr, never throw.
 */
export async function cleanupWorkerBranch(
  branchName: string,
  worktreePath: string,
  repoRoot: string,
): Promise<void> {
  const removeResult = await runGit(
    ['worktree', 'remove', '--force', worktreePath],
    repoRoot,
    10_000,
  )
  if (removeResult.exitCode !== 0) {
    process.stderr.write(
      `[orchestration] warn: could not remove worktree ${worktreePath}: ${removeResult.stderr.trim()}\n`,
    )
  }
  const deleteResult = await runGit(['branch', '-D', branchName], repoRoot, 10_000)
  if (deleteResult.exitCode !== 0) {
    process.stderr.write(
      `[orchestration] warn: could not delete branch ${branchName}: ${deleteResult.stderr.trim()}\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// mergeWorkerBranch
// ---------------------------------------------------------------------------

/**
 * Remove the worktree (required before merge) then merge the worker branch
 * into the current HEAD of repoRoot with --no-ff.
 *
 * On merge conflict: returns `{ merged: false, error: 'Merge conflict' }`.
 * On success: deletes the branch and returns `{ merged: true, error: null }`.
 */
export async function mergeWorkerBranch(
  branchName: string,
  worktreePath: string,
  repoRoot: string,
): Promise<{ merged: boolean; error: string | null }> {
  // Remove worktree first — git refuses to merge a branch checked out in a worktree
  const removeResult = await runGit(
    ['worktree', 'remove', '--force', worktreePath],
    repoRoot,
    10_000,
  )
  if (removeResult.exitCode !== 0) {
    process.stderr.write(
      `[orchestration] warn: could not remove worktree before merge ${worktreePath}: ${removeResult.stderr.trim()}\n`,
    )
  }

  const mergeResult = await runGit(
    ['merge', '--no-ff', branchName, '-m', `orchestration: merge ${branchName}`],
    repoRoot,
    30_000,
  )

  if (mergeResult.exitCode !== 0) {
    if (mergeResult.stderr.includes('CONFLICT') || mergeResult.stdout.includes('CONFLICT')) {
      // Abort the failed merge
      await runGit(['merge', '--abort'], repoRoot, 10_000)
      return { merged: false, error: 'Merge conflict' }
    }
    return { merged: false, error: mergeResult.stderr.trim() || `git merge exited ${mergeResult.exitCode}` }
  }

  // Delete the merged branch
  await runGit(['branch', '-d', branchName], repoRoot, 10_000)

  return { merged: true, error: null }
}
