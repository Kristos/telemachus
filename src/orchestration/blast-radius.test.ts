/**
 * Phase 66 (BLAST-01/02/03): regression test for the pre-merge blast-radius gate.
 *
 * Workers whose merge diff touches more than `blastRadiusThreshold` files are
 * escalated instead of merged. Uses the same spy harness as engine.test.ts
 * (spyOn on module exports — NEVER mock.module, per CLAUDE.md).
 *
 * Coverage:
 *   1. Fat diff (25 files, threshold 20) → escalated + audit + no merge
 *   2. Happy path (5 files, threshold 20) → approved + merged + no audit emit
 *   3. `git diff --name-only` failure → treat as 0 files, proceed to merge
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { SubagentParent } from '../agent/subagent.js'
import { ToolRegistry } from '../tools/registry.js'
import type { OrchestrationRunConfig } from './config-schema.js'
import type { WorkerHandoff } from './types.js'

import * as workerModule from './worker.js'
import * as reviewerModule from './reviewer.js'
import * as eventLogModule from './event-log.js'
import * as budgetModule from './budget.js'
import * as gitModule from './git.js'
import * as auditModule from '../security/audit.js'

import { runOrchestration } from './engine.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeParent(): SubagentParent {
  return {
    provider: {} as SubagentParent['provider'],
    registry: new ToolRegistry(),
    apiSchemas: [],
    toolContext: {
      cwd: '/tmp/test-repo-blast',
      toolTimeoutMs: 30_000,
      askUser: async () => '',
    },
    temperature: 0,
    windowSize: 100,
    maxIterations: 20,
  } as unknown as SubagentParent
}

function makeHandoff(taskId: string, runId: string, attempt: number): WorkerHandoff {
  return {
    taskId,
    runId,
    attemptNumber: attempt,
    branchName: `orchestration/${runId}/${taskId}/attempt-${attempt}`,
    worktreePath: `/tmp/worktree-${taskId}-${attempt}`,
    gitDiff: `diff --git a/file.ts\n+fake diff content attempt ${attempt}`,
    summary: `Completed attempt ${attempt}`,
    decisions: [],
    constraints_encountered: [],
  }
}

function makeSession() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0.001,
    turnCount: 1,
    lastTurn: null,
  }
}

function makeConfig(overrides?: Partial<OrchestrationRunConfig>): OrchestrationRunConfig {
  return {
    schemaVersion: 1,
    maxWorkerTurns: 10,
    maxRetries: 2,
    tasks: [{ id: 'task-blast', prompt: 'work', escalation: 'auto_accept' }],
    ...overrides,
  } as OrchestrationRunConfig
}

// Build a fake `git diff --name-only HEAD..<branch>` stdout with N files.
function fakeNameOnlyStdout(count: number): string {
  return Array.from({ length: count }, (_, i) => `src/file-${i}.ts`).join('\n')
}

// ── Spy lifecycle ───────────────────────────────────────────────────────────

describe('runOrchestration — blast radius gate (Phase 66)', () => {
  let replaySpy: ReturnType<typeof spyOn>
  let transitionSpy: ReturnType<typeof spyOn>
  let workerBudgetSpy: ReturnType<typeof spyOn>
  let reviewerBudgetSpy: ReturnType<typeof spyOn>
  let cleanupSpy: ReturnType<typeof spyOn>
  let mergeSpy: ReturnType<typeof spyOn>
  let runWorkerSpy: ReturnType<typeof spyOn>
  let runReviewerSpy: ReturnType<typeof spyOn>
  let runGitSpy: ReturnType<typeof spyOn>
  let auditSpy: ReturnType<typeof spyOn>
  let oldHome: string | undefined

  const auditCalls: Array<Record<string, unknown>> = []
  const mergeCalls: Array<{ branchName: string }> = []
  const gitCalls: Array<{ args: string[] }> = []

  beforeEach(() => {
    oldHome = process.env.HOME
    process.env.HOME = '/tmp/test-orch-blast-home'
    auditCalls.length = 0
    mergeCalls.length = 0
    gitCalls.length = 0

    replaySpy = spyOn(eventLogModule, 'replayEventLogFull').mockImplementation(async () => ({
      states: new Map<string, import('./types.js').OrchestrationState>(),
      accumulatedReviewerCost: 0,
    }))
    transitionSpy = spyOn(eventLogModule, 'appendTransition').mockImplementation(async () => {})
    workerBudgetSpy = spyOn(budgetModule, 'checkWorkerBudget').mockImplementation(() => null)
    reviewerBudgetSpy = spyOn(budgetModule, 'checkReviewerBudget').mockImplementation(() => null)
    cleanupSpy = spyOn(workerModule, 'cleanupWorkerBranch').mockImplementation(async () => {})
    mergeSpy = spyOn(workerModule, 'mergeWorkerBranch').mockImplementation(async (branchName: string) => {
      mergeCalls.push({ branchName })
      return { merged: true, error: null }
    })
    auditSpy = spyOn(auditModule, 'appendAuditEntry').mockImplementation(async (entry) => {
      auditCalls.push(entry as unknown as Record<string, unknown>)
    })
  })

  afterEach(() => {
    if (oldHome !== undefined) process.env.HOME = oldHome
    else delete process.env.HOME
    replaySpy.mockRestore()
    transitionSpy.mockRestore()
    workerBudgetSpy.mockRestore()
    reviewerBudgetSpy.mockRestore()
    cleanupSpy.mockRestore()
    mergeSpy.mockRestore()
    auditSpy.mockRestore()
    if (runWorkerSpy) runWorkerSpy.mockRestore()
    if (runReviewerSpy) runReviewerSpy.mockRestore()
    if (runGitSpy) runGitSpy.mockRestore()
  })

  function stubWorkerSucceed() {
    runWorkerSpy = spyOn(workerModule, 'runWorker').mockImplementation(
      async (taskId, runId, _task, _config, attempt) => ({
        handoff: makeHandoff(taskId as string, runId as string, attempt as number),
        session: makeSession() as unknown as import('../usage/tracker.js').UsageSession,
        error: null,
      }),
    )
  }

  function stubReviewerApprove() {
    runReviewerSpy = spyOn(reviewerModule, 'runReviewer').mockImplementation(async () => ({
      verdict: { verdict: 'approve' as const, feedback: 'LGTM' },
      session: makeSession() as unknown as import('../usage/tracker.js').UsageSession,
    }))
  }

  // Intercept ONLY the diff --name-only call; other runGit calls (e.g. ensureGitRepo
  // probes) fall through to a benign success stub.
  function stubGit(nameOnlyFiles: number, nameOnlyExitCode = 0) {
    runGitSpy = spyOn(gitModule, 'runGit').mockImplementation(
      async (args: string[]) => {
        gitCalls.push({ args })
        if (args[0] === 'diff' && args.includes('--name-only')) {
          return {
            stdout: nameOnlyExitCode === 0 ? fakeNameOnlyStdout(nameOnlyFiles) : '',
            stderr: nameOnlyExitCode === 0 ? '' : 'fatal: unknown revision',
            exitCode: nameOnlyExitCode,
            timedOut: false,
          }
        }
        // Default: succeed silently so ensureGitRepo / status probes don't blow up
        if (args[0] === 'rev-parse') {
          return { stdout: '.git\n', stderr: '', exitCode: 0, timedOut: false }
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      },
    )
  }

  // ── Test 1: fat diff escalates ───────────────────────────────────────────

  it('escalates the task when worker diff exceeds blastRadiusThreshold', async () => {
    const config = makeConfig({
      blastRadiusThreshold: 20,
      tasks: [{ id: 'task-blast', prompt: 'rogue work', escalation: 'auto_accept' }],
    })

    stubWorkerSucceed()
    stubReviewerApprove()
    stubGit(25) // 25 files in diff, threshold 20 → over

    const result = await runOrchestration(config, makeParent(), 'blast-fat-run-1')

    expect(result.taskResults).toHaveLength(1)
    expect(result.taskResults[0].finalState).toBe('escalated')

    // mergeWorkerBranch was NOT called
    expect(mergeCalls).toHaveLength(0)

    // audit event fired with the expected shape
    const blastAudits = auditCalls.filter((a) => a.kind === 'blast_radius_exceeded')
    expect(blastAudits).toHaveLength(1)
    expect(blastAudits[0].fileCount).toBe(25)
    expect(blastAudits[0].threshold).toBe(20)
    expect(blastAudits[0].taskId).toBe('task-blast')
    expect(typeof blastAudits[0].branch).toBe('string')
    expect(blastAudits[0].branch).toContain('task-blast')

    // diff --name-only was invoked
    const nameOnlyCalls = gitCalls.filter(
      (c) => c.args[0] === 'diff' && c.args.includes('--name-only'),
    )
    expect(nameOnlyCalls.length).toBeGreaterThanOrEqual(1)
  })

  // ── Test 2: happy path proceeds to merge ─────────────────────────────────

  it('allows merge when worker diff is within blastRadiusThreshold', async () => {
    const config = makeConfig({
      blastRadiusThreshold: 20,
      tasks: [{ id: 'task-small', prompt: 'tiny work', escalation: 'auto_accept' }],
    })

    stubWorkerSucceed()
    stubReviewerApprove()
    stubGit(5) // 5 files, threshold 20 → under

    const result = await runOrchestration(config, makeParent(), 'blast-small-run-1')

    expect(result.taskResults).toHaveLength(1)
    expect(result.taskResults[0].finalState).toBe('approved')
    expect(mergeCalls).toHaveLength(1)

    const blastAudits = auditCalls.filter((a) => a.kind === 'blast_radius_exceeded')
    expect(blastAudits).toHaveLength(0)
  })

  // ── Test 3: diff --name-only failure → fail-open (treat as 0 files, merge) ─

  it('proceeds to merge when git diff --name-only fails (fail-open)', async () => {
    const config = makeConfig({
      blastRadiusThreshold: 1,
      tasks: [{ id: 'task-gitfail', prompt: 'work', escalation: 'auto_accept' }],
    })

    stubWorkerSucceed()
    stubReviewerApprove()
    stubGit(0, /* nameOnlyExitCode */ 128) // git diff returns error

    const result = await runOrchestration(config, makeParent(), 'blast-gitfail-run-1')

    expect(result.taskResults).toHaveLength(1)
    expect(result.taskResults[0].finalState).toBe('approved')
    expect(mergeCalls).toHaveLength(1)

    const blastAudits = auditCalls.filter((a) => a.kind === 'blast_radius_exceeded')
    expect(blastAudits).toHaveLength(0)
  })
})
