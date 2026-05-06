/**
 * Phase 39: Unit tests for src/orchestration/worker.ts
 *
 * Coverage:
 *   WORK-01: runWorker calls runSubagent with submit_handoff tool and correct system prompt
 *   WORK-02: runWorker calls runGit with correct worktree branch name
 *   WORK-03: WorkerHandoff is fully populated when worker calls submit_handoff
 *   No-handoff: handoff:null + error when worker skips submit_handoff
 *   No-changes: error when worker produces no git changes
 */

import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import type { SubagentParent } from '../agent/subagent.js'
import type { UsageSession } from '../usage/tracker.js'
import type { OrchestrationRunConfig, TaskConfig } from './config-schema.js'
import type { RetryHistoryEntry } from './types.js'
import { ToolRegistry } from '../tools/registry.js'

// ---------------------------------------------------------------------------
// Helpers to build minimal test fixtures
// ---------------------------------------------------------------------------

function makeSession(): UsageSession {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    turnCount: 0,
    lastTurn: null,
  }
}

function makeParent(): SubagentParent {
  return {
    provider: {} as SubagentParent['provider'],
    registry: new ToolRegistry(),
    apiSchemas: [],
    toolContext: {
      cwd: '/fake/repo',
      toolTimeoutMs: 30_000,
      askUser: async () => '',
    },
    temperature: 0,
    windowSize: 20,
    maxIterations: 10,
  }
}

const defaultRunConfig: OrchestrationRunConfig = {
  schemaVersion: 1,
  maxWorkerTurns: 10,
  maxRetries: 2,
  tasks: [{ id: 'task1', prompt: 'Do the thing', escalation: 'auto_accept' }],
}

const defaultTask: TaskConfig = {
  id: 'task1',
  prompt: 'Do the thing',
  escalation: 'auto_accept',
}

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

// We import the real modules so we can spy on them
import * as subagentModule from '../agent/subagent.js'
import * as gitModule from './git.js'
import { runWorker, buildWorkerSystemPrompt, makeSubmitHandoffTool } from './worker.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeSubmitHandoffTool', () => {
  it('returns null before any call', () => {
    const { getHandoff } = makeSubmitHandoffTool()
    expect(getHandoff()).toBeNull()
  })

  it('captures handoff data after execute', async () => {
    const { tool, getHandoff } = makeSubmitHandoffTool()
    await tool.execute(
      { summary: 'Did work', decisions: ['chose A'], constraints_encountered: [] },
      {} as Parameters<typeof tool.execute>[1],
    )
    const h = getHandoff()
    expect(h).not.toBeNull()
    expect(h!.summary).toBe('Did work')
    expect(h!.decisions).toEqual(['chose A'])
  })

  it('returns success content on valid call', async () => {
    const { tool } = makeSubmitHandoffTool()
    const result = await tool.execute(
      { summary: 'Done', decisions: [], constraints_encountered: [] },
      {} as Parameters<typeof tool.execute>[1],
    )
    expect(result.isError).toBe(false)
    expect(result.content).toBe('Handoff submitted.')
  })
})

describe('buildWorkerSystemPrompt', () => {
  it('contains the task prompt', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [])
    expect(sp).toContain('Do the thing')
  })

  it('instructs to call submit_handoff', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [])
    expect(sp).toContain('submit_handoff')
  })

  it('adds prior attempts when retryHistory is non-empty', () => {
    const history: RetryHistoryEntry[] = [
      { attemptNumber: 1, gitDiff: '', summary: 'Did X', reviewerFeedback: 'Fix Y' },
    ]
    const sp = buildWorkerSystemPrompt(defaultTask, history)
    expect(sp).toContain('PRIOR ATTEMPTS')
    expect(sp).toContain('Did X')
    expect(sp).toContain('Fix Y')
  })

  it('does not add PRIOR ATTEMPTS section when history is empty', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [])
    expect(sp).not.toContain('PRIOR ATTEMPTS')
  })
})

// ── Phase 56 (POOL-01): buildWorkerSystemPrompt staticContext tests ──────────

describe('buildWorkerSystemPrompt — staticContext (Phase 56 POOL-01)', () => {
  it('WPOOL-01: prepends <static_context cache="ephemeral"> block when staticContext provided', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [], 'PROJECT body here')
    expect(sp).toMatch(/^<static_context cache="ephemeral">\nPROJECT body here\n<\/static_context>\n\n/)
  })

  it('WPOOL-02: prompt without staticContext starts with "You are a code worker agent"', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [])
    expect(sp).toMatch(/^You are a code worker agent\./)
  })

  it('WPOOL-03: empty staticContext string produces no <static_context> block', () => {
    const sp = buildWorkerSystemPrompt(defaultTask, [], '')
    expect(sp).toMatch(/^You are a code worker agent\./)
    expect(sp).not.toContain('<static_context')
  })

  it('WPOOL-04: cache marker appears exactly once in prompt (no duplicate markers)', () => {
    const longCtx = '# Project\n'.repeat(100)
    const sp = buildWorkerSystemPrompt(defaultTask, [], longCtx)
    const markerCount = (sp.match(/<static_context cache="ephemeral">/g) ?? []).length
    expect(markerCount).toBe(1)
  })
})

describe('runWorker', () => {
  // We'll track what runSubagent and runGit were called with
  let runSubagentSpy: ReturnType<typeof spyOn>
  let runGitSpy: ReturnType<typeof spyOn>
  let submitHandoffCapture: ((args: unknown) => void) | null

  /**
   * Set up spies for each test. Each test configures the mock behavior
   * by overriding these before calling runWorker.
   */
  function setupMocks({
    submitHandoff = true,
    hasChanges = true,
  }: {
    submitHandoff?: boolean
    hasChanges?: boolean
  } = {}) {
    submitHandoffCapture = null

    // Mock runGit — return appropriate results based on args
    runGitSpy = spyOn(gitModule, 'runGit').mockImplementation(
      async (args: string[], _cwd: string, _timeout?: number) => {
        const cmd = args.join(' ')

        if (cmd.startsWith('worktree add')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('status --porcelain')) {
          return {
            stdout: hasChanges ? 'M  some-file.ts' : '',
            stderr: '',
            exitCode: 0,
            timedOut: false as boolean,
          }
        }
        if (cmd.startsWith('log --oneline')) {
          return { stdout: 'abc1234 initial commit', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('add -A')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('commit')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('diff HEAD^')) {
          return {
            stdout: hasChanges ? '+added line\n-removed line\n' : '',
            stderr: '',
            exitCode: 0,
            timedOut: false as boolean,
          }
        }
        if (cmd.startsWith('show')) {
          return {
            stdout: hasChanges ? '+added line\n' : '',
            stderr: '',
            exitCode: 0,
            timedOut: false as boolean,
          }
        }
        if (cmd.startsWith('diff HEAD~1')) {
          return {
            stdout: hasChanges ? ' 1 file changed' : '',
            stderr: '',
            exitCode: 0,
            timedOut: false as boolean,
          }
        }
        // default
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
      },
    )

    // Mock runSubagent — simulates agent calling (or not calling) submit_handoff
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockImplementation(
      async (_parent, _prompt, overrides) => {
        // Find submit_handoff in the registry if submitHandoff=true
        if (submitHandoff && overrides?.registry) {
          const reg = overrides.registry as ToolRegistry
          const tool = reg.find('submit_handoff')
          if (tool) {
            await tool.execute(
              {
                summary: 'Did the task work',
                decisions: ['chose approach A'],
                constraints_encountered: ['rate limit'],
              },
              {} as Parameters<typeof tool.execute>[1],
            )
          }
        }
        // Fire onTurnComplete if provided
        if (overrides?.onTurnComplete) {
          overrides.onTurnComplete({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 })
        }
        return { text: 'done', messages: [], error: null }
      },
    )
  }

  beforeEach(() => {
    runSubagentSpy?.mockRestore?.()
    runGitSpy?.mockRestore?.()
  })

  // WORK-01: runSubagent called with submit_handoff in registry + correct system prompt
  it('WORK-01: calls runSubagent with submit_handoff tool in registry', async () => {
    setupMocks()
    const parent = makeParent()
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    expect(runSubagentSpy).toHaveBeenCalledTimes(1)
    const [, , overrides] = runSubagentSpy.mock.calls[0] as [unknown, unknown, { registry?: ToolRegistry; systemPrompt?: string; onTurnComplete?: unknown }]
    expect(overrides.registry).toBeDefined()
    const registry = overrides.registry as ToolRegistry
    const submitTool = registry.find('submit_handoff')
    expect(submitTool).toBeDefined()
    expect(submitTool!.name).toBe('submit_handoff')
  })

  it('WORK-01: system prompt contains task prompt text', async () => {
    setupMocks()
    const parent = makeParent()
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    const [, , overrides] = runSubagentSpy.mock.calls[0] as [unknown, unknown, { systemPrompt?: string }]
    expect(overrides.systemPrompt).toContain('Do the thing')
  })

  it('WORK-01: onTurnComplete callback is present in overrides', async () => {
    setupMocks()
    const parent = makeParent()
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    const [, , overrides] = runSubagentSpy.mock.calls[0] as [unknown, unknown, { onTurnComplete?: unknown }]
    expect(typeof overrides.onTurnComplete).toBe('function')
  })

  // WORK-02: runGit called with correct branch name + worktree path structure
  it('WORK-02: calls runGit with correct worktree branch name', async () => {
    setupMocks()
    const parent = makeParent()
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    const worktreeCalls = runGitSpy.mock.calls.filter(
      ([args]: [string[]]) => args[0] === 'worktree' && args[1] === 'add',
    )
    expect(worktreeCalls.length).toBeGreaterThan(0)
    const [worktreeArgs] = worktreeCalls[0] as [string[]]
    // Branch name is at index 3 (after 'worktree', 'add', '-b')
    expect(worktreeArgs[3]).toBe('orchestration/run1/task1/attempt-1')
  })

  it('WORK-02: worktree path contains run dir structure', async () => {
    setupMocks()
    const parent = makeParent()
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    const worktreeCalls = runGitSpy.mock.calls.filter(
      ([args]: [string[]]) => args[0] === 'worktree' && args[1] === 'add',
    )
    const [worktreeArgs] = worktreeCalls[0] as [string[]]
    // worktree path at index 4
    const worktreePath = worktreeArgs[4]
    expect(worktreePath).toContain('run1')
    expect(worktreePath).toContain('task1')
    expect(worktreePath).toContain('attempt-1')
    expect(worktreePath).toContain('worktree')
  })

  // WORK-03: WorkerHandoff fully populated
  it('WORK-03: returns populated WorkerHandoff when worker calls submit_handoff', async () => {
    setupMocks()
    const parent = makeParent()
    const result = await runWorker(
      'task1',
      'run1',
      defaultTask,
      defaultRunConfig,
      1,
      [],
      parent,
      makeSession(),
    )

    expect(result.error).toBeNull()
    expect(result.handoff).not.toBeNull()
    const h = result.handoff!

    expect(h.taskId).toBe('task1')
    expect(h.runId).toBe('run1')
    expect(h.attemptNumber).toBe(1)
    expect(h.branchName).toBe('orchestration/run1/task1/attempt-1')
    expect(h.worktreePath).toContain('worktree')
    expect(h.gitDiff).toContain('+added line')
    expect(h.summary).toBe('Did the task work')
    expect(h.decisions).toEqual(['chose approach A'])
    expect(h.constraints_encountered).toEqual(['rate limit'])
  })

  // No-handoff: worker skips submit_handoff
  it('No-handoff: returns handoff:null with error when worker does not call submit_handoff', async () => {
    setupMocks({ submitHandoff: false })
    const parent = makeParent()
    const result = await runWorker(
      'task1',
      'run1',
      defaultTask,
      defaultRunConfig,
      1,
      [],
      parent,
      makeSession(),
    )

    expect(result.handoff).toBeNull()
    expect(result.error).toContain('submit_handoff')
  })

  // WPOOL-05: runWorker threads parent.staticContext into buildWorkerSystemPrompt via systemPrompt
  it('WPOOL-05: runWorker passes parent.staticContext into system prompt sent to subagent', async () => {
    setupMocks()
    const parent: ReturnType<typeof makeParent> & { staticContext?: string } = {
      ...makeParent(),
      staticContext: 'POOL-01 context block',
    }
    await runWorker('task1', 'run1', defaultTask, defaultRunConfig, 1, [], parent, makeSession())

    // The systemPrompt passed to runSubagent should contain the static_context block
    const [, , overrides] = runSubagentSpy.mock.calls[0] as [unknown, unknown, { systemPrompt?: string }]
    expect(overrides.systemPrompt).toBeDefined()
    expect(overrides.systemPrompt).toContain('<static_context cache="ephemeral">')
    expect(overrides.systemPrompt).toContain('POOL-01 context block')
  })

  // No-changes: worker produces no git changes
  it('No-changes: returns error when worker makes no git changes', async () => {
    // No uncommitted changes, and mock log shows only 1 commit, diff shows nothing
    runGitSpy = spyOn(gitModule, 'runGit').mockImplementation(
      async (args: string[], _cwd: string, _timeout?: number) => {
        const cmd = args.join(' ')
        if (cmd.startsWith('worktree add')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('status --porcelain')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean } // clean
        }
        if (cmd.startsWith('log --oneline')) {
          return { stdout: 'abc1234 initial commit', stderr: '', exitCode: 0, timedOut: false as boolean }
        }
        if (cmd.startsWith('diff HEAD~1')) {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean } // no diff
        }
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false as boolean }
      },
    )

    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockImplementation(
      async (_parent, _prompt, overrides) => {
        // Worker calls submit_handoff
        if (overrides?.registry) {
          const reg = overrides.registry as ToolRegistry
          const tool = reg.find('submit_handoff')
          if (tool) {
            await tool.execute(
              { summary: 'Did nothing', decisions: [], constraints_encountered: [] },
              {} as Parameters<typeof tool.execute>[1],
            )
          }
        }
        return { text: 'done', messages: [], error: null }
      },
    )

    const parent = makeParent()
    const result = await runWorker(
      'task1',
      'run1',
      defaultTask,
      defaultRunConfig,
      1,
      [],
      parent,
      makeSession(),
    )

    expect(result.handoff).toBeNull()
    expect(result.error).toContain('git changes')
  })
})
