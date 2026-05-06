/**
 * Phase 44-01: Unit tests for src/orchestration/decomposer.ts
 *
 * Covers:
 *   - extractJSON: markdown-fenced, bare, invalid
 *   - decompose: valid output, schema validation, cycle detection
 *   - decompose: linear chain warning when >60% sequential
 *   - decompose: unknown dependsOn ID rejection
 *   - decompose: template context injected into system prompt
 *   - decompose: dependsOnRationale preserved in plan text
 *
 * Uses spyOn (not mock.module) per project convention — prevents Bun
 * cross-test module contamination.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import type { SubagentParent } from '../agent/subagent.js'
import { ToolRegistry } from '../tools/registry.js'

// ── Import real modules for spying ──────────────────────────────────────────
import * as subagentModule from '../agent/subagent.js'
import * as templatesModule from './templates/index.js'
import { extractJSON, decompose } from './decomposer.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const minimalConfig = {
  schemaVersion: 1,
  maxWorkerTurns: 20,
  maxRetries: 2,
  tasks: [
    { id: 'task-a', prompt: 'Do task A', escalation: 'require_human' },
    { id: 'task-b', prompt: 'Do task B', escalation: 'require_human' },
  ],
}

const configWithDeps = {
  schemaVersion: 1,
  tasks: [
    { id: 'task-a', prompt: 'Create auth middleware', escalation: 'require_human' },
    {
      id: 'task-b',
      prompt: 'Create products endpoint',
      dependsOn: ['task-a'],
      dependsOnRationale: ['auth middleware must exist before products endpoint'],
      escalation: 'require_human',
    },
  ],
}

// ---------------------------------------------------------------------------
// extractJSON tests
// ---------------------------------------------------------------------------

describe('extractJSON', () => {
  it('extracts JSON from markdown-fenced block', () => {
    const text = 'Here is the plan:\n```json\n{"key": "value"}\n```\nDone.'
    const result = extractJSON(text)
    expect(result).toEqual({ key: 'value' })
  })

  it('extracts bare JSON from text containing a JSON object', () => {
    const text = 'Some preamble {"schemaVersion": 1, "tasks": []} some postamble'
    const result = extractJSON(text)
    expect(result).toEqual({ schemaVersion: 1, tasks: [] })
  })

  it('returns null for completely invalid / non-JSON output', () => {
    const result = extractJSON('This is not JSON at all.')
    expect(result).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractJSON('')).toBeNull()
  })

  it('handles fenced block with extra whitespace', () => {
    const text = '```json\n  { "a": 1 }  \n```'
    const result = extractJSON(text)
    expect(result).toEqual({ a: 1 })
  })
})

// ---------------------------------------------------------------------------
// decompose tests
// ---------------------------------------------------------------------------

describe('decompose', () => {
  let runSubagentSpy: ReturnType<typeof spyOn>
  let getTemplatesSpy: ReturnType<typeof spyOn>
  let capturedSystemPrompt: string | undefined

  afterEach(() => {
    runSubagentSpy?.mockRestore()
    getTemplatesSpy?.mockRestore()
  })

  beforeEach(() => {
    capturedSystemPrompt = undefined

    getTemplatesSpy = spyOn(templatesModule, 'getTemplatesForDecomposer').mockReturnValue(
      'TEMPLATE_CONTEXT_STUB',
    )

    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockImplementation(
      async (_parent, _prompt, overrides = {}) => {
        // Only capture the first system prompt (decomposer's call).
        // The validator's subsequent call would overwrite capturedSystemPrompt otherwise.
        if (capturedSystemPrompt === undefined) {
          capturedSystemPrompt = overrides.systemPrompt
        }
        return {
          text: '```json\n' + JSON.stringify(minimalConfig) + '\n```',
          messages: [],
          error: null,
        }
      },
    )
  })

  it('returns a valid OrchestrationRunConfig when LLM output is well-formed', async () => {
    const result = await decompose({ parent: makeParent(), prompt: 'Build something' })
    expect(result.config.schemaVersion).toBe(1)
    expect(result.config.tasks).toHaveLength(2)
    expect(result.config.tasks[0].id).toBe('task-a')
  })

  it('byte-identical planText output when dependencyFlags is empty (clean plan regression)', async () => {
    const result = await decompose({ parent: makeParent(), prompt: 'Build something' })
    // Empty flags = no Dependency Warnings section anywhere in output
    expect(result.planText).not.toContain('Dependency Warnings')
    expect(result.planText).not.toContain('⚠')
    // Ends exactly as before
    expect(result.planText.endsWith('Approve this plan? (y/n)')).toBe(true)
    // dependencyFlags field is present and empty
    expect(result.dependencyFlags).toEqual([])
  })

  it('includes template context from getTemplatesForDecomposer in system prompt', async () => {
    await decompose({ parent: makeParent(), prompt: 'Build something' })
    expect(capturedSystemPrompt).toContain('TEMPLATE_CONTEXT_STUB')
  })

  it('includes dependsOnRationale in planText when present', async () => {
    runSubagentSpy.mockImplementation(async (_parent, _prompt, overrides = {}) => {
      capturedSystemPrompt = overrides.systemPrompt
      return {
        text: '```json\n' + JSON.stringify(configWithDeps) + '\n```',
        messages: [],
        error: null,
      }
    })

    const result = await decompose({ parent: makeParent(), prompt: 'Build API' })
    expect(result.planText).toContain('auth middleware must exist before products endpoint')
    expect(result.planText).toContain('Rationale:')
  })

  it('rejects output with circular dependsOn (A->B->A cycle)', async () => {
    const cycleConfig = {
      schemaVersion: 1,
      tasks: [
        { id: 'a', prompt: 'Task A', dependsOn: ['b'], escalation: 'require_human' },
        { id: 'b', prompt: 'Task B', dependsOn: ['a'], escalation: 'require_human' },
      ],
    }
    runSubagentSpy.mockImplementation(async () => ({
      text: '```json\n' + JSON.stringify(cycleConfig) + '\n```',
      messages: [],
      error: null,
    }))

    await expect(decompose({ parent: makeParent(), prompt: 'test' })).rejects.toThrow(
      /circular dependencies/i,
    )
  })

  it('rejects output with unknown dependsOn task IDs', async () => {
    const unknownDepConfig = {
      schemaVersion: 1,
      tasks: [
        {
          id: 'task-a',
          prompt: 'Do A',
          dependsOn: ['nonexistent-task'],
          escalation: 'require_human',
        },
      ],
    }
    runSubagentSpy.mockImplementation(async () => ({
      text: '```json\n' + JSON.stringify(unknownDepConfig) + '\n```',
      messages: [],
      error: null,
    }))

    await expect(decompose({ parent: makeParent(), prompt: 'test' })).rejects.toThrow(
      /unknown task ID/i,
    )
  })

  it('adds linear chain warning when >60% of tasks form a single chain', async () => {
    // 5 tasks, 4 form a linear chain (80% > 60%)
    const linearConfig = {
      schemaVersion: 1,
      tasks: [
        { id: 't1', prompt: 'Task 1', escalation: 'require_human' },
        { id: 't2', prompt: 'Task 2', dependsOn: ['t1'], escalation: 'require_human' },
        { id: 't3', prompt: 'Task 3', dependsOn: ['t2'], escalation: 'require_human' },
        { id: 't4', prompt: 'Task 4', dependsOn: ['t3'], escalation: 'require_human' },
        { id: 't5', prompt: 'Task 5', dependsOn: ['t4'], escalation: 'require_human' },
      ],
    }
    runSubagentSpy.mockImplementation(async () => ({
      text: '```json\n' + JSON.stringify(linearConfig) + '\n```',
      messages: [],
      error: null,
    }))

    const result = await decompose({ parent: makeParent(), prompt: 'test' })
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('Linear chain detected')
  })

  it('does not add linear chain warning when chain is <= 60% sequential', async () => {
    // 5 tasks, only 2 are sequential (40% < 60%)
    const parallelConfig = {
      schemaVersion: 1,
      tasks: [
        { id: 't1', prompt: 'Task 1', escalation: 'require_human' },
        { id: 't2', prompt: 'Task 2', dependsOn: ['t1'], escalation: 'require_human' },
        { id: 't3', prompt: 'Task 3', escalation: 'require_human' },
        { id: 't4', prompt: 'Task 4', escalation: 'require_human' },
        { id: 't5', prompt: 'Task 5', escalation: 'require_human' },
      ],
    }
    runSubagentSpy.mockImplementation(async () => ({
      text: '```json\n' + JSON.stringify(parallelConfig) + '\n```',
      messages: [],
      error: null,
    }))

    const result = await decompose({ parent: makeParent(), prompt: 'test' })
    expect(result.warnings).toHaveLength(0)
  })

  it('throws when runSubagent returns an error', async () => {
    runSubagentSpy.mockImplementation(async () => ({
      text: '',
      messages: [],
      error: new Error('Provider unavailable'),
    }))

    await expect(decompose({ parent: makeParent(), prompt: 'test' })).rejects.toThrow(
      /Decomposer agent failed/,
    )
  })

  it('throws when output is not valid JSON', async () => {
    runSubagentSpy.mockImplementation(async () => ({
      text: 'I cannot help with that request.',
      messages: [],
      error: null,
    }))

    await expect(decompose({ parent: makeParent(), prompt: 'test' })).rejects.toThrow(
      /did not produce valid JSON/i,
    )
  })

  it('throws when Zod validation fails (missing required fields)', async () => {
    runSubagentSpy.mockImplementation(async () => ({
      text: '```json\n{"tasks": []}\n```',
      messages: [],
      error: null,
    }))

    await expect(decompose({ parent: makeParent(), prompt: 'test' })).rejects.toThrow(
      /schema validation/i,
    )
  })

  // ---------------------------------------------------------------------------
  // Phase 52 integration tests: validateDependencies wired into decompose()
  // ---------------------------------------------------------------------------

  /**
   * Stub runSubagent that branches on system prompt content to mimic both
   * decomposer and validator responses. The decomposer system prompt includes
   * "orchestration planner"; the validator system prompt includes "dependency validator".
   */
  function makeSmartStub(
    decomposerResponse: object,
    validatorResponse: object | { error: Error },
  ) {
    return async (_parent: unknown, _prompt: unknown, overrides: { systemPrompt?: string } = {}) => {
      const sp = overrides.systemPrompt ?? ''
      if (sp.includes('dependency validator')) {
        if ('error' in validatorResponse && validatorResponse.error) {
          return { text: '', messages: [], error: (validatorResponse as { error: Error }).error }
        }
        return {
          text: '```json\n' + JSON.stringify(validatorResponse) + '\n```',
          messages: [],
          error: null,
        }
      }
      // Decomposer path
      return {
        text: '```json\n' + JSON.stringify(decomposerResponse) + '\n```',
        messages: [],
        error: null,
      }
    }
  }

  it('flags configure-tailwind missing dependsOn: init-project (canonical v3.2 incident fixture)', async () => {
    const decomposerResp = {
      schemaVersion: 1,
      tasks: [
        { id: 'init-project', prompt: 'Create Vite project', escalation: 'require_human' },
        {
          id: 'configure-tailwind',
          prompt: 'Add Tailwind config to root',
          escalation: 'require_human',
        },
      ],
    }
    const validatorResp = {
      flags: [
        {
          taskId: 'configure-tailwind',
          suggestedDep: 'init-project',
          rationale:
            'configure-tailwind writes Tailwind config files into the project root which init-project creates first',
        },
      ],
    }
    runSubagentSpy.mockImplementation(makeSmartStub(decomposerResp, validatorResp))

    const result = await decompose({ parent: makeParent(), prompt: 'Build a Tailwind site' })

    expect(result.dependencyFlags).toHaveLength(1)
    expect(result.dependencyFlags[0].taskId).toBe('configure-tailwind')
    expect(result.dependencyFlags[0].suggestedDep).toBe('init-project')
    expect(result.dependencyFlags[0].rationale).toContain('project root')

    expect(result.planText).toContain('Dependency Warnings:')
    expect(result.planText).toContain('⚠ configure-tailwind may need dependsOn: init-project')
    expect(result.planText).toContain('project root')
    expect(result.planText.endsWith('Approve this plan? (y/n)')).toBe(true)
  })

  it('renders planText without Dependency Warnings section when validator returns empty flags', async () => {
    runSubagentSpy.mockImplementation(makeSmartStub(minimalConfig, { flags: [] }))
    const result = await decompose({ parent: makeParent(), prompt: 'Build something' })
    expect(result.dependencyFlags).toEqual([])
    expect(result.planText).not.toContain('Dependency Warnings')
    expect(result.planText).not.toContain('⚠')
  })

  it('decompose resolves and dependencyFlags is [] when validator LLM call errors', async () => {
    runSubagentSpy.mockImplementation(
      makeSmartStub(minimalConfig, { error: new Error('Validator LLM unavailable') }),
    )
    const result = await decompose({ parent: makeParent(), prompt: 'Build something' })
    expect(result.dependencyFlags).toEqual([])
    expect(result.planText).not.toContain('Dependency Warnings')
  })
})
