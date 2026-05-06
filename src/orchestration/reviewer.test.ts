/**
 * Phase 39-02: Unit tests for the reviewer module.
 *
 * Covers:
 *   - makeSubmitReviewTool basics (closure capture, valid/invalid input)
 *   - REV-01: reviewer system prompt contains gitDiff and task.prompt
 *   - REV-02: reviewer exits without tool call → verdict defaults to reject
 *   - REV-02: redirect verdict is captured correctly
 *   - Reviewer registry is isolated (exactly 1 tool: submit_review)
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { SubagentParent, SubagentOverrides } from '../agent/subagent.js'
import type { WorkerHandoff } from './types.js'
import type { TaskConfig, OrchestrationRunConfig } from './config-schema.js'
import type { ToolContext } from '../tools/types.js'
import type { UsageSession } from '../usage/tracker.js'

// ── Mock runSubagent ──────────────────────────────────────────────────────────
//
// The mock is configured per-test via `mockBehavior`. By default it does
// nothing (simulating freetext / no tool call — REV-02 base case). Tests that
// want to simulate a successful tool call set `mockBehavior = 'call_submit_review'`
// with the desired verdict before calling runReviewer.

type MockBehavior =
  | { type: 'noop' }
  | { type: 'call_submit_review'; verdict: 'approve' | 'reject' | 'redirect'; feedback: string }

let mockBehavior: MockBehavior = { type: 'noop' }

const runSubagentCalls: Array<{
  parent: SubagentParent
  prompt: string
  overrides: SubagentOverrides
}> = []

mock.module('../agent/subagent.js', () => ({
  runSubagent: async (
    parent: SubagentParent,
    prompt: string,
    overrides: SubagentOverrides = {},
  ) => {
    runSubagentCalls.push({ parent, prompt, overrides })

    if (mockBehavior.type === 'call_submit_review') {
      // Simulate the LLM calling submit_review during the agent loop.
      const registry = overrides.registry
      if (registry) {
        const submitTool = registry.find('submit_review')
        if (submitTool) {
          const dummyCtx: ToolContext = {
            cwd: '/tmp',
            toolTimeoutMs: 5000,
            askUser: async () => '',
          }
          await submitTool.execute(
            { verdict: mockBehavior.verdict, feedback: mockBehavior.feedback },
            dummyCtx,
          )
        }
      }
    }

    return { text: '', messages: [], error: null }
  },
}))

// ── Import the module AFTER mocking its dependency ────────────────────────────
import { makeSubmitReviewTool, runReviewer } from './reviewer.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const dummyContext: ToolContext = {
  cwd: '/tmp',
  toolTimeoutMs: 5000,
  askUser: async () => '',
}

function makeTestHandoff(): WorkerHandoff {
  return {
    taskId: 'test-task',
    runId: 'test-run',
    attemptNumber: 1,
    branchName: 'orchestration/test-run/test-task/attempt-1',
    worktreePath: '/tmp/test-worktree',
    gitDiff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new',
    summary: 'Changed foo',
    decisions: ['used bar pattern'],
    constraints_encountered: [],
  }
}

function makeTestTask(): TaskConfig {
  return {
    id: 'test-task',
    prompt: 'Refactor foo.ts to use the bar pattern',
    escalation: 'auto_accept',
  }
}

function makeTestRunConfig(): OrchestrationRunConfig {
  return {
    schemaVersion: 1,
    maxWorkerTurns: 20,
    maxRetries: 2,
    tasks: [makeTestTask()],
  }
}

function makeTestParent(): SubagentParent {
  return {
    provider: {} as SubagentParent['provider'],
    registry: {} as SubagentParent['registry'],
    apiSchemas: [],
    toolContext: dummyContext,
    temperature: 0,
    windowSize: 50,
    maxIterations: 20,
  }
}

function makeTestSession(): UsageSession {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    turnCount: 0,
    lastTurn: null,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('makeSubmitReviewTool', () => {
  it('getVerdict returns null before any tool call', () => {
    const { getVerdict } = makeSubmitReviewTool()
    expect(getVerdict()).toBeNull()
  })

  it('captures verdict after successful tool.execute call', async () => {
    const { tool, getVerdict } = makeSubmitReviewTool()
    const result = await tool.execute({ verdict: 'approve', feedback: 'LGTM' }, dummyContext)
    expect(result).toEqual({ content: 'Review submitted.', isError: false })
    expect(getVerdict()).toEqual({ verdict: 'approve', feedback: 'LGTM' })
  })

  it('returns isError: true for invalid input (bad verdict string)', async () => {
    const { tool, getVerdict } = makeSubmitReviewTool()
    const result = await tool.execute({ verdict: 'invalid_value' }, dummyContext)
    expect(result.isError).toBe(true)
    // Verdict must NOT be captured on invalid input
    expect(getVerdict()).toBeNull()
  })

  it('returns isError: true when feedback is missing', async () => {
    const { tool, getVerdict } = makeSubmitReviewTool()
    const result = await tool.execute({ verdict: 'approve' }, dummyContext)
    expect(result.isError).toBe(true)
    expect(getVerdict()).toBeNull()
  })
})

describe('runReviewer', () => {
  beforeEach(() => {
    mockBehavior = { type: 'noop' }
    runSubagentCalls.length = 0
  })

  it('REV-01: system prompt contains the gitDiff from handoff', async () => {
    mockBehavior = { type: 'call_submit_review', verdict: 'approve', feedback: 'Good diff' }

    await runReviewer(
      makeTestHandoff(),
      makeTestTask(),
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(runSubagentCalls).toHaveLength(1)
    const { overrides } = runSubagentCalls[0]
    expect(overrides.systemPrompt).toContain(makeTestHandoff().gitDiff)
  })

  it('REV-01: system prompt contains the task prompt', async () => {
    mockBehavior = { type: 'call_submit_review', verdict: 'approve', feedback: 'All good' }

    const task = makeTestTask()
    await runReviewer(
      makeTestHandoff(),
      task,
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(runSubagentCalls).toHaveLength(1)
    const { overrides } = runSubagentCalls[0]
    expect(overrides.systemPrompt).toContain(task.prompt)
  })

  it('REV-02: freetext exit (no submit_review call) returns reject verdict', async () => {
    // Default mockBehavior is noop — reviewer exits without calling submit_review
    mockBehavior = { type: 'noop' }

    const { verdict } = await runReviewer(
      makeTestHandoff(),
      makeTestTask(),
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(verdict.verdict).toBe('reject')
    expect(verdict.feedback).toContain('submit_review')
  })

  it('REV-02: redirect verdict is captured correctly', async () => {
    mockBehavior = {
      type: 'call_submit_review',
      verdict: 'redirect',
      feedback: 'Fix the error handling',
    }

    const { verdict } = await runReviewer(
      makeTestHandoff(),
      makeTestTask(),
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(verdict.verdict).toBe('redirect')
    expect(verdict.feedback).toBe('Fix the error handling')
  })

  it('reviewer registry contains exactly 1 tool named submit_review (REV-01 isolation)', async () => {
    mockBehavior = { type: 'call_submit_review', verdict: 'approve', feedback: 'OK' }

    await runReviewer(
      makeTestHandoff(),
      makeTestTask(),
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(runSubagentCalls).toHaveLength(1)
    const { overrides } = runSubagentCalls[0]
    const tools = overrides.registry?.getAll() ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('submit_review')
  })

  it('approve verdict is captured correctly', async () => {
    mockBehavior = { type: 'call_submit_review', verdict: 'approve', feedback: 'LGTM' }

    const { verdict } = await runReviewer(
      makeTestHandoff(),
      makeTestTask(),
      makeTestRunConfig(),
      makeTestParent(),
      makeTestSession(),
    )

    expect(verdict.verdict).toBe('approve')
    expect(verdict.feedback).toBe('LGTM')
  })
})
