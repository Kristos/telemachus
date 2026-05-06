/**
 * Phase 39: Orchestration engine — the central loop.
 *
 * Drives tasks serially through the worker → reviewer → terminal state cycle.
 * Handles:
 * - Retry on redirect (retryHistory injection per REV-03)
 * - Escalation on max retries exhaustion
 * - Branch merge on approval; cleanup on rejection
 * - Merge conflict → escalated (per D-03)
 * - Artifact persistence per attempt (handoffs, verdicts)
 * - Crash recovery via event log replay
 *
 * Exports: runOrchestration, OrchestrationResult, TaskResult
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubagentParent } from '../agent/subagent.js'
import { createSession } from '../usage/tracker.js'
import type { OrchestrationRunConfig, TaskConfig } from './config-schema.js'
import { appendTransition, replayEventLogFull, runDir } from './event-log.js'
import { ReviewerCostAccumulator, checkReviewerBudget, checkWorkerBudget } from './budget.js'
import { runGit } from './git.js'
import { TaskQueue, detectCycle, type QueueEntry } from './queue.js'
import { runReviewer } from './reviewer.js'
import { transition } from './state-machine.js'
import { TERMINAL_STATES, type OrchestrationState, type RetryHistoryEntry } from './types.js'
import {
  cleanupWorkerBranch,
  mergeWorkerBranch,
  runWorker,
} from './worker.js'
import { buildWaveSnapshot, shouldGate, type WaveFailFastPrompt } from './wave-fail-fast.js'
import { appendAuditEntry } from '../security/audit.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  runId: string
  taskResults: TaskResult[]
}

export interface TaskResult {
  taskId: string
  finalState: OrchestrationState
  attempts: number
  error?: string
}

/**
 * Callback hooks for observing orchestration events without coupling to
 * transports (CLI stdout, Discord DM, etc.).
 *
 * All methods are optional — the engine runs unchanged without them.
 */
export interface OrchestrationHooks {
  /**
   * Called after every state transition. Use for real-time status streaming.
   * @param taskId  - The task that transitioned
   * @param from    - Previous state
   * @param to      - New state
   * @param data    - Optional structured context from the transition event
   */
  onTaskTransition?: (
    taskId: string,
    from: OrchestrationState,
    to: OrchestrationState,
    data?: Record<string, unknown>,
  ) => void
  /**
   * Called when a task reaches max retries or merge conflict and the task's
   * escalation policy is 'require_human'. Allows a transport (Discord DM) to
   * gate the escalation on human approval.
   *
   * Return 'approve' to accept and merge; return 'reject' to keep the
   * terminal escalated state.
   *
   * @param taskId          - The escalated task
   * @param diff            - Git diff of the last worker attempt
   * @param reviewerFeedback - Last reviewer feedback message
   * @param timeoutMs       - Max milliseconds to wait for human response
   */
  onEscalated?: (
    taskId: string,
    diff: string,
    reviewerFeedback: string,
    timeoutMs: number,
  ) => Promise<'approve' | 'reject'>
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Serializes concurrent merge calls to prevent parallel git merge races.
 *
 * In the parallel dispatch loop, multiple tasks may reach 'approved' state
 * concurrently. Without serialization, concurrent `git merge` calls on the
 * same repo HEAD would race and corrupt the working tree.
 *
 * Uses the same promise-chain pattern as writeChains (event-log.ts) and
 * persistChain (queue.ts) — established in Phase 41.
 *
 * Errors are NOT swallowed: a failing merge rejects the returned promise,
 * but the chain continues so subsequent merges proceed unblocked.
 */
class MergeSerializer {
  private chain: Promise<void> = Promise.resolve()

  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn())
    this.chain = next.then(
      () => {},
      () => {},
    )
    return next
  }
}

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Find the config index for a taskId.
 * Throws if not found — used when repairing configIndex:-1 from crash replay.
 */
function resolveConfigIndex(taskId: string, config: OrchestrationRunConfig): number {
  const idx = config.tasks.findIndex((t) => t.id === taskId)
  if (idx === -1) {
    throw new Error(`Task ${taskId} not found in config — cannot resolve configIndex`)
  }
  return idx
}

/**
 * Build a dependency map from a run config.
 * Maps each task ID to the list of task IDs it directly depends on.
 * Tasks with no dependsOn are omitted (callers treat missing keys as []).
 */
function buildDepMap(config: OrchestrationRunConfig): Map<string, string[]> {
  const depMap = new Map<string, string[]>()
  for (const task of config.tasks) {
    if (task.dependsOn && task.dependsOn.length > 0) {
      depMap.set(task.id, [...task.dependsOn])
    }
  }
  return depMap
}

/**
 * Persist a JSON artifact to {runDir}/{runId}/tasks/{taskId}/{filename}.
 * Errors go to stderr, never throw.
 */
async function persistArtifact(
  runId: string,
  taskId: string,
  filename: string,
  data: unknown,
): Promise<void> {
  try {
    const dir = join(runDir(runId), 'tasks', taskId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    process.stderr.write(
      `[orchestration] warn: could not persist artifact ${filename}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

/**
 * Ensure that `path` exists AND is a git repository with at least one commit.
 * If the path is not a git repo, runs `git init` + an empty initial commit so
 * that downstream `git worktree add/remove` operations have a HEAD to branch
 * from. Throws if any step fails — a non-git repo root is a fatal setup error.
 *
 * Fixes the chicken-and-egg case where an orchestration run starts in a
 * directory that isn't (yet) a git repo — e.g., the Discord bot's launchd cwd
 * when the decomposer omitted `projectDir`. Without this, every worktree
 * create/remove produced "fatal: not a git repository" stderr warnings and
 * the init-project task would fail before doing any real work.
 */
export async function ensureGitRepo(path: string): Promise<void> {
  // Create the directory if missing so runGit can even set cwd. Safe in
  // production (target is always the project dir we want) and tolerant of
  // tests whose fake cwd doesn't exist on disk.
  await mkdir(path, { recursive: true })

  const gitCheck = await runGit(['rev-parse', '--git-dir'], path, 5_000)
  if (gitCheck.exitCode === 0) return

  const initResult = await runGit(['init'], path, 10_000)
  if (initResult.exitCode !== 0) {
    throw new Error(`Failed to git init ${path}: ${initResult.stderr.trim()}`)
  }
  // Create initial commit so worktrees have a HEAD to branch from.
  // Use -c flags to set a fallback identity in case the runner has no global
  // git config (e.g. CI environments). Does not persist to .git/config.
  const commitResult = await runGit(
    [
      '-c', 'user.email=orchestration@telemachus',
      '-c', 'user.name=Telemachus Orchestration',
      'commit', '--allow-empty', '-m', 'Initial commit',
    ],
    path,
    10_000,
  )
  if (commitResult.exitCode !== 0) {
    throw new Error(
      `Failed to create initial commit in ${path}: ${commitResult.stderr.trim()}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Inner task processor
// ---------------------------------------------------------------------------

/**
 * Process a single task through the worker → reviewer → terminal cycle.
 * Supports internal retries on redirect per REV-03.
 *
 * @param entry - Queue entry for this task
 * @param config - Full run config
 * @param parent - SubagentParent (carries provider, tools, cwd)
 * @param queue - The task queue (mutated via updateState)
 * @param effectiveRunId - The run ID for this orchestration run
 * @param budget - Legacy mutable budget tracking object (used when budgetAccumulator absent)
 * @param hooks - Optional observer hooks for state transitions and escalation
 * @param mergeSerializer - When present, all mergeWorkerBranch calls are serialized through it
 * @param budgetAccumulator - When present, reviewer cost is tracked atomically via accumulator
 */
async function processTask(
  entry: QueueEntry,
  config: OrchestrationRunConfig,
  parent: SubagentParent,
  queue: TaskQueue,
  effectiveRunId: string,
  budget: { reviewerCost: number },
  hooks?: OrchestrationHooks,
  mergeSerializer?: MergeSerializer,
  budgetAccumulator?: ReviewerCostAccumulator,
): Promise<TaskResult> {
  const taskId = entry.taskId
  const task: TaskConfig = config.tasks[entry.configIndex]

  const maxRetries = task.maxRetries ?? config.maxRetries

  let attemptNumber = 1
  const retryHistory: RetryHistoryEntry[] = []
  let currentState: OrchestrationState = entry.state

  while (true) {
    // ===================================================================
    // WORKER PHASE
    // ===================================================================

    // Transition: currentState → worker_running
    const t1 = transition(currentState, 'worker_running', taskId, { attempt: attemptNumber })
    await appendTransition(effectiveRunId, t1)
    hooks?.onTaskTransition?.(taskId, t1.fromState, t1.toState, t1.data)
    queue.updateState(taskId, 'worker_running')

    // Check worker budget BEFORE running the worker
    const workerSession = createSession()
    const workerBudgetBlock = checkWorkerBudget(task, config, workerSession)
    if (workerBudgetBlock) {
      const tFail = transition('worker_running', 'failed', taskId, {
        reason: 'worker_budget_exceeded',
        kind: workerBudgetBlock.kind,
        limit: workerBudgetBlock.limit,
        used: workerBudgetBlock.used,
      })
      await appendTransition(effectiveRunId, tFail)
      hooks?.onTaskTransition?.(taskId, tFail.fromState, tFail.toState, tFail.data)
      queue.updateState(taskId, 'failed')
      return {
        taskId,
        finalState: 'failed',
        attempts: attemptNumber,
        error: 'Worker budget exceeded',
      }
    }

    // Run the worker agent
    const workerResult = await runWorker(
      taskId,
      effectiveRunId,
      task,
      config,
      attemptNumber,
      retryHistory,
      parent,
      workerSession,
    )

    // Persist handoff artifact (or error)
    await persistArtifact(
      effectiveRunId,
      taskId,
      `attempt-${attemptNumber}-handoff.json`,
      workerResult.handoff ?? { error: workerResult.error },
    )

    // Worker failed to produce a handoff
    if (!workerResult.handoff) {
      // Attempt cleanup even though we may not have a valid worktree path
      const branchName = `orchestration/${effectiveRunId}/${taskId}/attempt-${attemptNumber}`
      const worktreePath = `${runDir(effectiveRunId)}/tasks/${taskId}/attempt-${attemptNumber}/worktree`
      await cleanupWorkerBranch(branchName, worktreePath, parent.toolContext.cwd)

      const tFail = transition('worker_running', 'failed', taskId, {
        reason: 'worker_failed',
        error: workerResult.error,
      })
      await appendTransition(effectiveRunId, tFail)
      hooks?.onTaskTransition?.(taskId, tFail.fromState, tFail.toState, tFail.data)
      queue.updateState(taskId, 'failed')
      return {
        taskId,
        finalState: 'failed',
        attempts: attemptNumber,
        error: workerResult.error ?? 'Unknown worker error',
      }
    }

    // ===================================================================
    // REVIEW PHASE
    // ===================================================================

    const t2 = transition('worker_running', 'review_pending', taskId, { attempt: attemptNumber })
    await appendTransition(effectiveRunId, t2)
    hooks?.onTaskTransition?.(taskId, t2.fromState, t2.toState, t2.data)
    queue.updateState(taskId, 'review_pending')

    // Check reviewer budget before running reviewer
    const reviewerBudgetBlock = checkReviewerBudget(
      config,
      budgetAccumulator ?? budget.reviewerCost,
    )
    if (reviewerBudgetBlock) {
      await cleanupWorkerBranch(
        workerResult.handoff.branchName,
        workerResult.handoff.worktreePath,
        parent.toolContext.cwd,
      )
      const tFail = transition('review_pending', 'failed', taskId, {
        reason: 'reviewer_budget_exceeded',
        kind: reviewerBudgetBlock.kind,
        limit: reviewerBudgetBlock.limit,
        used: reviewerBudgetBlock.used,
      })
      await appendTransition(effectiveRunId, tFail)
      hooks?.onTaskTransition?.(taskId, tFail.fromState, tFail.toState, tFail.data)
      queue.updateState(taskId, 'failed')
      return {
        taskId,
        finalState: 'failed',
        attempts: attemptNumber,
        error: 'Reviewer budget exceeded',
      }
    }

    const t3 = transition('review_pending', 'reviewing', taskId)
    await appendTransition(effectiveRunId, t3)
    hooks?.onTaskTransition?.(taskId, t3.fromState, t3.toState, t3.data)
    queue.updateState(taskId, 'reviewing')

    // Run the reviewer agent
    const reviewerResult = await runReviewer(
      workerResult.handoff,
      task,
      config,
      parent,
      createSession(),
    )
    if (budgetAccumulator) {
      await budgetAccumulator.add(reviewerResult.session.totalCost)
    } else {
      budget.reviewerCost += reviewerResult.session.totalCost
    }

    // Persist verdict artifact
    await persistArtifact(
      effectiveRunId,
      taskId,
      `attempt-${attemptNumber}-verdict.json`,
      reviewerResult.verdict,
    )

    // ===================================================================
    // VERDICT HANDLING
    // ===================================================================

    if (reviewerResult.verdict.verdict === 'approve') {
      // ─────────────────────────────────────────────────────────────────────
      // Phase 66 (BLAST-03): blast-radius gate.
      //
      // Count files touched by the worker branch versus HEAD. If the total
      // exceeds config.blastRadiusThreshold, escalate instead of merging.
      // Mirrors the wave_fail_fast precedent: count something, compare to
      // threshold, emit audit event (best-effort), transition to terminal
      // state. Fail-open: if `git diff --name-only` errors, fileCount = 0
      // and we fall through to the normal merge path (gate must never break
      // the happy path on a git quirk).
      //
      // The gate runs BEFORE the mergeSerializer.serialize(doMerge) wrapper
      // because file counting is a read-only git op that doesn't need the
      // merge lock. The branch is NOT deleted on gate breach — it stays on
      // disk for human inspection (mirrors merge-conflict behavior at line
      // ~439 below).
      // ─────────────────────────────────────────────────────────────────────
      const blastBranch = workerResult.handoff!.branchName
      let blastFileCount = 0
      try {
        const diffNames = await runGit(
          ['diff', '--name-only', `HEAD..${blastBranch}`],
          parent.toolContext.cwd,
          10_000,
        )
        if (diffNames.exitCode === 0) {
          blastFileCount = diffNames.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0).length
        } else {
          process.stderr.write(
            `[orchestration] warn: blast-radius diff probe failed for ${blastBranch} (exit ${diffNames.exitCode}): ${diffNames.stderr.trim().slice(0, 200)}\n`,
          )
        }
      } catch (err) {
        process.stderr.write(
          `[orchestration] warn: blast-radius diff probe threw for ${blastBranch}: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }

      if (blastFileCount > config.blastRadiusThreshold) {
        // Best-effort audit emit — never blocks the transition.
        void appendAuditEntry({
          ts: new Date().toISOString(),
          kind: 'blast_radius_exceeded',
          sessionId: effectiveRunId,
          platform: process.platform,
          taskId,
          branch: blastBranch,
          fileCount: blastFileCount,
          threshold: config.blastRadiusThreshold,
        })

        const tBlast = transition('reviewing', 'escalated', taskId, {
          reason: 'blast_radius_exceeded',
          fileCount: blastFileCount,
          threshold: config.blastRadiusThreshold,
          reviewerFeedback: reviewerResult.verdict.feedback,
          reviewerCostUsd: reviewerResult.session.totalCost,
        })

        // Optional human override — mirror merge-conflict onEscalated pattern.
        // If the human approves despite blast radius, fall through to the
        // normal merge path with humanOverride + blastRadiusOverride markers.
        if (task.escalation === 'require_human' && hooks?.onEscalated) {
          const diff = workerResult.handoff.gitDiff
          const feedback = reviewerResult.verdict.feedback
          const timeoutMs = (config.escalationTimeoutMinutes ?? 30) * 60 * 1000
          const decision = await hooks.onEscalated(taskId, diff, feedback, timeoutMs)
          if (decision === 'approve') {
            const doMergeOverride = () =>
              mergeWorkerBranch(
                workerResult.handoff!.branchName,
                workerResult.handoff!.worktreePath,
                parent.toolContext.cwd,
              )
            const mergeOverrideResult = mergeSerializer
              ? await mergeSerializer.serialize(doMergeOverride)
              : await doMergeOverride()
            if (mergeOverrideResult.merged) {
              const tApproveHuman = transition('reviewing', 'approved', taskId, {
                reviewerFeedback: feedback,
                reviewerCostUsd: reviewerResult.session.totalCost,
                humanOverride: true,
                blastRadiusOverride: true,
                fileCount: blastFileCount,
                threshold: config.blastRadiusThreshold,
              })
              await appendTransition(effectiveRunId, tApproveHuman)
              hooks?.onTaskTransition?.(taskId, tApproveHuman.fromState, tApproveHuman.toState, tApproveHuman.data)
              queue.updateState(taskId, 'approved')
              return { taskId, finalState: 'approved', attempts: attemptNumber }
            }
            // Merge failed even after human approval — fall through to escalated
          }
        }

        await appendTransition(effectiveRunId, tBlast)
        hooks?.onTaskTransition?.(taskId, tBlast.fromState, tBlast.toState, tBlast.data)
        queue.updateState(taskId, 'escalated')
        return {
          taskId,
          finalState: 'escalated',
          attempts: attemptNumber,
          error: `blast_radius_exceeded: ${blastFileCount} > ${config.blastRadiusThreshold}`,
        }
      }

      // Attempt to merge worker branch into repo HEAD (serialized to prevent concurrent merge races)
      const doMerge = () =>
        mergeWorkerBranch(
          workerResult.handoff!.branchName,
          workerResult.handoff!.worktreePath,
          parent.toolContext.cwd,
        )
      const mergeResult = mergeSerializer ? await mergeSerializer.serialize(doMerge) : await doMerge()

      if (!mergeResult.merged) {
        // Merge conflict → escalate per D-03
        const tEsc = transition('reviewing', 'escalated', taskId, {
          reason: 'merge_conflict',
          error: mergeResult.error,
          reviewerFeedback: reviewerResult.verdict.feedback,
          reviewerCostUsd: reviewerResult.session.totalCost,
        })
        // Check onEscalated hook before committing the escalated transition
        if (task.escalation === 'require_human' && hooks?.onEscalated) {
          const diff = workerResult.handoff.gitDiff
          const feedback = reviewerResult.verdict.feedback
          const timeoutMs = (config.escalationTimeoutMinutes ?? 30) * 60 * 1000
          const decision = await hooks.onEscalated(taskId, diff, feedback, timeoutMs)
          if (decision === 'approve') {
            // Human approved despite conflict — write approved transition instead
            const tApproveHuman = transition('reviewing', 'approved', taskId, {
              reviewerFeedback: feedback,
              reviewerCostUsd: reviewerResult.session.totalCost,
              humanOverride: true,
            })
            await appendTransition(effectiveRunId, tApproveHuman)
            hooks?.onTaskTransition?.(taskId, tApproveHuman.fromState, tApproveHuman.toState, tApproveHuman.data)
            queue.updateState(taskId, 'approved')
            return { taskId, finalState: 'approved', attempts: attemptNumber }
          }
        }
        await appendTransition(effectiveRunId, tEsc)
        hooks?.onTaskTransition?.(taskId, tEsc.fromState, tEsc.toState, tEsc.data)
        queue.updateState(taskId, 'escalated')
        return {
          taskId,
          finalState: 'escalated',
          attempts: attemptNumber,
          error: mergeResult.error ?? 'Merge conflict',
        }
      }

      const tApprove = transition('reviewing', 'approved', taskId, {
        reviewerFeedback: reviewerResult.verdict.feedback,
        reviewerCostUsd: reviewerResult.session.totalCost,
      })
      await appendTransition(effectiveRunId, tApprove)
      hooks?.onTaskTransition?.(taskId, tApprove.fromState, tApprove.toState, tApprove.data)
      queue.updateState(taskId, 'approved')
      return { taskId, finalState: 'approved', attempts: attemptNumber }
    }

    if (reviewerResult.verdict.verdict === 'reject') {
      // Delete the worker branch on rejection
      await cleanupWorkerBranch(
        workerResult.handoff.branchName,
        workerResult.handoff.worktreePath,
        parent.toolContext.cwd,
      )
      const tReject = transition('reviewing', 'rejected', taskId, {
        reviewerFeedback: reviewerResult.verdict.feedback,
        reviewerCostUsd: reviewerResult.session.totalCost,
      })
      await appendTransition(effectiveRunId, tReject)
      hooks?.onTaskTransition?.(taskId, tReject.fromState, tReject.toState, tReject.data)
      queue.updateState(taskId, 'rejected')
      return { taskId, finalState: 'rejected', attempts: attemptNumber }
    }

    // verdict === 'redirect'
    // Check if max retries exhausted (maxRetries=2 means 1 initial + 2 retries = 3 total attempts)
    if (attemptNumber >= maxRetries + 1) {
      // Max retries exhausted → escalate directly from reviewing
      await cleanupWorkerBranch(
        workerResult.handoff.branchName,
        workerResult.handoff.worktreePath,
        parent.toolContext.cwd,
      )
      const tEsc = transition('reviewing', 'escalated', taskId, {
        reason: 'max_retries_exhausted',
        attempt: attemptNumber,
        reviewerFeedback: reviewerResult.verdict.feedback,
        reviewerCostUsd: reviewerResult.session.totalCost,
      })
      // Check onEscalated hook before committing the escalated transition
      if (task.escalation === 'require_human' && hooks?.onEscalated) {
        const diff = workerResult.handoff.gitDiff
        const feedback = reviewerResult.verdict.feedback
        const timeoutMs = (config.escalationTimeoutMinutes ?? 30) * 60 * 1000
        const decision = await hooks.onEscalated(taskId, diff, feedback, timeoutMs)
        if (decision === 'approve') {
          // Human approved — merge the branch and transition to approved (serialized)
          const doMergeHuman = () =>
            mergeWorkerBranch(
              workerResult.handoff!.branchName,
              workerResult.handoff!.worktreePath,
              parent.toolContext.cwd,
            )
          const mergeResult = mergeSerializer
            ? await mergeSerializer.serialize(doMergeHuman)
            : await doMergeHuman()
          if (mergeResult.merged) {
            const tApproveHuman = transition('reviewing', 'approved', taskId, {
              reviewerFeedback: feedback,
              reviewerCostUsd: reviewerResult.session.totalCost,
              humanOverride: true,
            })
            await appendTransition(effectiveRunId, tApproveHuman)
            hooks?.onTaskTransition?.(taskId, tApproveHuman.fromState, tApproveHuman.toState, tApproveHuman.data)
            queue.updateState(taskId, 'approved')
            return { taskId, finalState: 'approved', attempts: attemptNumber }
          }
          // Merge failed even after human approval — fall through to escalated
        }
      }
      await appendTransition(effectiveRunId, tEsc)
      hooks?.onTaskTransition?.(taskId, tEsc.fromState, tEsc.toState, tEsc.data)
      queue.updateState(taskId, 'escalated')
      return {
        taskId,
        finalState: 'escalated',
        attempts: attemptNumber,
        error: `Max retries (${maxRetries}) exhausted`,
      }
    }

    // Redirect — log it, cleanup branch, build retry history, loop
    const tRedirect = transition('reviewing', 'redirected', taskId, {
      reviewerFeedback: reviewerResult.verdict.feedback,
      reviewerCostUsd: reviewerResult.session.totalCost,
      attempt: attemptNumber,
    })
    await appendTransition(effectiveRunId, tRedirect)
    hooks?.onTaskTransition?.(taskId, tRedirect.fromState, tRedirect.toState, tRedirect.data)

    // Cleanup this attempt's branch before retrying
    await cleanupWorkerBranch(
      workerResult.handoff.branchName,
      workerResult.handoff.worktreePath,
      parent.toolContext.cwd,
    )

    // Build retry history entry per REV-03
    retryHistory.push({
      attemptNumber,
      gitDiff: workerResult.handoff.gitDiff,
      summary: workerResult.handoff.summary,
      reviewerFeedback: reviewerResult.verdict.feedback,
    })

    // Prepare for next attempt.
    // redirected → queued is NOT a valid state-machine transition (redirected is terminal).
    // We log a synthetic event directly (bypassing transition()) for audit purposes,
    // then update the queue state and loop.
    const syntheticRequeue: import('./types.js').TaskTransitionEvent = {
      taskId,
      fromState: 'redirected',
      toState: 'queued',
      timestamp: new Date().toISOString(),
      data: { retryAttempt: attemptNumber + 1, synthetic: true },
    }
    await appendTransition(effectiveRunId, syntheticRequeue)
    hooks?.onTaskTransition?.(taskId, syntheticRequeue.fromState, syntheticRequeue.toState, syntheticRequeue.data)

    attemptNumber += 1
    queue.updateState(taskId, 'queued')
    currentState = 'queued'
    // Continue while loop — next iteration: queued → worker_running
  }
}

// ---------------------------------------------------------------------------
// Phase 56 (POOL-01): one-time context read helper
// ---------------------------------------------------------------------------

/**
 * Read planning context files ONCE per orchestration run.
 * Missing files are skipped silently. Returns empty string when none exist.
 * NOT memoized at module level (BUD-03) — each runOrchestration call re-reads.
 */
async function readContextFiles(cwd: string): Promise<string> {
  const files = [
    { name: 'PROJECT.md', path: `${cwd}/.planning/PROJECT.md` },
    { name: 'ROADMAP.md', path: `${cwd}/.planning/ROADMAP.md` },
    { name: 'STATE.md',   path: `${cwd}/.planning/STATE.md` },
  ]
  const parts: string[] = []
  for (const f of files) {
    try {
      const content = await readFile(f.path, 'utf8')
      parts.push(`## ${f.name}\n${content}`)
    } catch {
      // Missing or unreadable — skip silently
    }
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// runOrchestration — the main entry point
// ---------------------------------------------------------------------------

/**
 * Run the orchestration engine for the given config.
 *
 * Processes all tasks serially through worker → reviewer → terminal state.
 * Supports crash recovery via event log replay when a runId is provided that
 * has a pre-existing event log.
 *
 * @param config - Parsed and validated OrchestrationRunConfig
 * @param parent - SubagentParent providing provider, tools, and cwd
 * @param runId - Optional run ID (generated if absent). Provide to resume after crash.
 * @param hooks - Optional observer hooks for state transitions and human escalation
 */
export async function runOrchestration(
  config: OrchestrationRunConfig,
  parent: SubagentParent,
  runId?: string,
  hooks?: OrchestrationHooks,
): Promise<OrchestrationResult> {
  const effectiveRunId = runId ?? generateRunId()

  // Handle projectDir: create directory + git init if needed
  let effectiveParent = parent
  if (config.projectDir) {
    const { mkdir } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const { homedir } = await import('node:os')
    const projectPath = resolve(config.projectDir.replace(/^~/, homedir()))

    await mkdir(projectPath, { recursive: true })

    await ensureGitRepo(projectPath)

    // Override parent's CWD to the project directory
    effectiveParent = {
      ...parent,
      toolContext: {
        ...parent.toolContext,
        cwd: projectPath,
        originalCwd: projectPath,
      },
    }
    hooks?.onTaskTransition?.('_setup', 'queued' as OrchestrationState, 'approved' as OrchestrationState, { projectDir: projectPath })
  } else {
    // No projectDir specified. The worker-reviewer loop creates per-task git
    // worktrees from effectiveParent.toolContext.cwd, so that path MUST be a
    // git repo with at least one commit. If it isn't (common when the bot
    // launches from `/` under launchd, or the decomposer omitted projectDir),
    // worktree creation and cleanup both fail with "not a git repository".
    // Guarantee it here so downstream code can assume a valid repo root.
    await ensureGitRepo(parent.toolContext.cwd)
  }

  // Phase 56 (POOL-01): one-time shared context read, threaded via SubagentParent.
  // Reads PROJECT.md + ROADMAP.md + STATE.md exactly once per run — not once
  // per worker. Missing files are silently skipped (BUD-03: no module-level cache).
  const staticContext = await readContextFiles(effectiveParent.toolContext.cwd)
  effectiveParent = { ...effectiveParent, staticContext: staticContext || undefined }

  // Build dependency map from config tasks
  const depMap = buildDepMap(config)

  // Validate: all referenced task IDs must exist in the config
  const taskIds = new Set(config.tasks.map((t) => t.id))
  for (const [taskId, deps] of depMap) {
    for (const depId of deps) {
      if (!taskIds.has(depId)) {
        throw new Error(`Task "${taskId}" depends on unknown task "${depId}"`)
      }
    }
  }

  // Validate: no circular dependencies
  const cycle = detectCycle(depMap)
  if (cycle !== null) {
    throw new Error(cycle)
  }

  const maxParallel = config.maxParallel

  // Attempt crash recovery via event log replay
  const { states: replayedStates, accumulatedReviewerCost } =
    await replayEventLogFull(effectiveRunId)

  let queue: TaskQueue

  if (replayedStates.size > 0) {
    // Crash recovery: reconstruct queue from replayed state
    queue = TaskQueue.fromReplay(effectiveRunId, replayedStates, depMap, maxParallel)

    // Repair configIndex:-1 entries set by Phase 38 fromReplay
    for (const entry of queue.getAll()) {
      if ((entry as QueueEntry).configIndex === -1) {
        const resolved = resolveConfigIndex(entry.taskId, config)
        // Rebuild entry with correct configIndex via updateState trick:
        // TaskQueue doesn't expose configIndex repair directly, so we work
        // around it by casting — the queue's entries are rebuilt immutably.
        ;(entry as { configIndex: number }).configIndex = resolved
      }
    }
  } else {
    // Fresh run: enqueue all tasks
    queue = new TaskQueue(effectiveRunId, depMap, maxParallel)
    config.tasks.forEach((task, i) => {
      queue.enqueue({ taskId: task.id, state: 'queued', configIndex: i })
    })
  }

  // Cross-task reviewer budget tracking
  // budgetAccumulator is used for parallel execution (atomic, promise-chain serialized).
  // budget is kept for legacy path (unused when accumulator is present).
  const budget = { reviewerCost: accumulatedReviewerCost }
  const budgetAccumulator = new ReviewerCostAccumulator(accumulatedReviewerCost)
  const mergeSerializer = new MergeSerializer()

  // Parallel dispatch loop: dispatch all ready tasks concurrently each iteration,
  // then wait for the batch before checking for newly-ready tasks.
  const taskResults: TaskResult[] = []
  // Phase 53: wave counter — incremented per Promise.allSettled call (per-batch).
  let waveNumber = 0

  while (true) {
    const ready = queue.getReadyTasks()

    if (ready.length === 0) {
      // No ready tasks — check if any tasks are still in-flight
      const allTerminalOrQueued = queue
        .getAll()
        .every((e) => e.state === 'queued' || TERMINAL_STATES.has(e.state))

      if (allTerminalOrQueued) {
        // All remaining queued tasks have unmet deps (deps failed/rejected/escalated)
        break
      }

      // Some tasks still in-flight — wait a tick for them to complete
      await new Promise<void>((r) => setTimeout(r, 50))
      continue
    }

    // Phase 53: increment wave counter for the upcoming Promise.allSettled batch.
    waveNumber += 1

    // Dispatch all ready tasks concurrently
    const batch = ready.map((entry) =>
      processTask(
        entry,
        config,
        effectiveParent,
        queue,
        effectiveRunId,
        budget,
        hooks,
        mergeSerializer,
        budgetAccumulator,
      ),
    )

    const results = await Promise.allSettled(batch)

    // Phase 53: Collect THIS wave's fulfilled results separately so the
    // fail-fast gate operates on the wave only (not cumulative taskResults).
    const waveResults: TaskResult[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        taskResults.push(r.value)
        waveResults.push(r.value)
      }
    }

    // Phase 53: Wave fail-fast gate.
    // CONTEXT decision 5: early-exit when no failures in this wave — zero overhead
    // on the happy path.
    const failedCount = waveResults.reduce((n, r) => (r.finalState === 'failed' ? n + 1 : n), 0)
    if (failedCount > 0) {
      const threshold = config.waveFailFastThreshold ?? 0.5
      const snapshot = buildWaveSnapshot(waveNumber, waveResults, threshold)
      // CONTEXT decision 6: shouldGate short-circuits when threshold >= 1.0.
      if (shouldGate(snapshot.rate, threshold)) {
        const prompt: WaveFailFastPrompt | undefined =
          typeof config.waveFailFastPrompt === 'function'
            ? (config.waveFailFastPrompt as WaveFailFastPrompt)
            : undefined
        const decision = prompt ? await prompt(snapshot) : ('continue' as const)

        // Emit audit entry — best-effort, never throw (appendAuditEntry swallows errors internally)
        void appendAuditEntry({
          ts: new Date().toISOString(),
          kind: 'wave_fail_fast',
          sessionId: effectiveRunId,
          platform: process.platform,
          waveNumber: snapshot.waveNumber,
          rate: snapshot.rate,
          threshold: snapshot.threshold,
          decision: prompt ? decision : 'no_callback',
        })

        // CONTEXT decision 1: 'abort' breaks the dispatch loop; queued tasks remain
        // queued and are synthesized by the post-loop block below.
        if (decision === 'abort') {
          break
        }
        // 'continue' falls through to the next while iteration normally.
      }
    }
  }

  // Collect results for tasks that were never dispatched (blocked deps in non-approved terminal)
  for (const entry of queue.getAll()) {
    if (!taskResults.some((r) => r.taskId === entry.taskId)) {
      taskResults.push({
        taskId: entry.taskId,
        finalState: entry.state as OrchestrationState,
        attempts: 0,
        error: entry.state === 'queued' ? 'Blocked: dependencies not met' : undefined,
      })
    }
  }

  return { runId: effectiveRunId, taskResults }
}
