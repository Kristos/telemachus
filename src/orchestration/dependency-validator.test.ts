import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import {
  renderDependencyWarningsSection,
  DependencyValidatorResponseSchema,
  formatTaskTableForValidator,
  buildValidatorSystemPrompt,
  validateDependencies,
  computeValidatorTimeoutMs,
  type DependencyFlag,
  type ValidatorTaskInput,
} from './dependency-validator.js'
import * as subagentModule from '../agent/subagent.js'
import * as auditModule from '../security/audit.js'
import { ToolRegistry } from '../tools/registry.js'

describe('renderDependencyWarningsSection', () => {
  it('returns empty string for empty flags array', () => {
    expect(renderDependencyWarningsSection([])).toBe('')
  })

  it('returns exact section format for a single flag', () => {
    const flags: DependencyFlag[] = [
      {
        taskId: 'configure-tailwind',
        suggestedDep: 'init-project',
        rationale: 'Tailwind config writes into project root that init-project creates first',
      },
    ]
    const result = renderDependencyWarningsSection(flags)
    expect(result).toBe(
      '\nDependency Warnings:\n  ⚠ configure-tailwind may need dependsOn: init-project — Tailwind config writes into project root that init-project creates first',
    )
  })

  it('renders one warning line per flag under a single header', () => {
    const flags: DependencyFlag[] = [
      { taskId: 'task-b', suggestedDep: 'task-a', rationale: 'reads files from task-a' },
      { taskId: 'task-c', suggestedDep: 'task-b', rationale: 'calls code defined by task-b' },
    ]
    const result = renderDependencyWarningsSection(flags)
    expect(result).toBe(
      '\nDependency Warnings:\n  ⚠ task-b may need dependsOn: task-a — reads files from task-a\n  ⚠ task-c may need dependsOn: task-b — calls code defined by task-b',
    )
    // Exactly one "Dependency Warnings:" header
    expect(result.split('Dependency Warnings:').length - 1).toBe(1)
  })
})

describe('DependencyValidatorResponseSchema', () => {
  it('parses a valid response with one flag', () => {
    const input = {
      flags: [{ taskId: 'a', suggestedDep: 'b', rationale: 'because...' }],
    }
    const result = DependencyValidatorResponseSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.flags).toHaveLength(1)
      expect(result.data.flags[0].taskId).toBe('a')
    }
  })

  it('parses a valid response with empty flags array', () => {
    const result = DependencyValidatorResponseSchema.safeParse({ flags: [] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.flags).toHaveLength(0)
    }
  })

  it('rejects input missing the flags field', () => {
    const result = DependencyValidatorResponseSchema.safeParse({ something: 'else' })
    expect(result.success).toBe(false)
  })

  it('rejects a flag entry missing taskId', () => {
    const result = DependencyValidatorResponseSchema.safeParse({
      flags: [{ suggestedDep: 'b', rationale: 'because...' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a flag entry with an empty string field', () => {
    const result = DependencyValidatorResponseSchema.safeParse({
      flags: [{ taskId: '', suggestedDep: 'b', rationale: 'because...' }],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task 1: formatTaskTableForValidator + buildValidatorSystemPrompt
// ---------------------------------------------------------------------------

const canonicalTasks: ValidatorTaskInput[] = [
  { id: 'init-project', prompt: 'Create a new Vite + React + TypeScript project', dependsOn: [] },
  {
    id: 'configure-tailwind',
    prompt: 'Add Tailwind CSS configuration to the project root',
    dependsOn: [],
  },
  {
    id: 'add-routing',
    prompt: 'Set up react-router routes for /home and /about',
    dependsOn: ['init-project'],
  },
]

describe('formatTaskTableForValidator', () => {
  it('produces the exact canonical 3-task table', () => {
    const table = formatTaskTableForValidator(canonicalTasks)
    const expected = [
      'taskId | prompt (first 80 chars) | dependsOn',
      '-------|-------------------------|----------',
      'init-project | Create a new Vite + React + TypeScript project | (none)',
      'configure-tailwind | Add Tailwind CSS configuration to the project root | (none)',
      'add-routing | Set up react-router routes for /home and /about | init-project',
    ].join('\n')
    expect(table).toBe(expected)
  })

  it('truncates a prompt longer than 80 chars with trailing ...', () => {
    const tasks: ValidatorTaskInput[] = [
      {
        id: 'long-task',
        prompt: 'A'.repeat(81),
        dependsOn: [],
      },
    ]
    const table = formatTaskTableForValidator(tasks)
    // Row should contain the first 80 chars + '...'
    expect(table).toContain(`${'A'.repeat(80)}...`)
    // Should not contain 81 A's
    expect(table).not.toContain('A'.repeat(81))
  })

  it('shows (none) when dependsOn is missing or empty', () => {
    const tasks: ValidatorTaskInput[] = [
      { id: 'task-a', prompt: 'Do something' },
      { id: 'task-b', prompt: 'Do another thing', dependsOn: [] },
    ]
    const table = formatTaskTableForValidator(tasks)
    const rows = table.split('\n').slice(2) // skip header + separator
    expect(rows[0]).toContain('(none)')
    expect(rows[1]).toContain('(none)')
  })
})

describe('buildValidatorSystemPrompt', () => {
  it('contains the passed task table verbatim', () => {
    const table = formatTaskTableForValidator(canonicalTasks)
    const prompt = buildValidatorSystemPrompt(table)
    expect(prompt).toContain(table)
  })

  it('contains the json fence instruction', () => {
    const prompt = buildValidatorSystemPrompt('table content')
    expect(prompt).toContain('```json')
  })

  it('contains the rationale requirement language', () => {
    const prompt = buildValidatorSystemPrompt('table content')
    expect(prompt.toLowerCase()).toContain('rationale')
  })
})

// ---------------------------------------------------------------------------
// Task 2: validateDependencies()
// ---------------------------------------------------------------------------

import type { SubagentParent } from '../agent/subagent.js'

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

const twoTasks: ValidatorTaskInput[] = [
  { id: 'init-project', prompt: 'Create Vite project' },
  { id: 'configure-tailwind', prompt: 'Add Tailwind config to root' },
]

describe('computeValidatorTimeoutMs', () => {
  it('returns the 10s baseline for small plans', () => {
    expect(computeValidatorTimeoutMs(1)).toBe(10_000)
    expect(computeValidatorTimeoutMs(3)).toBe(10_000)
    expect(computeValidatorTimeoutMs(5)).toBe(10_000)
  })

  it('scales at 2s per task above the 5-task baseline', () => {
    expect(computeValidatorTimeoutMs(6)).toBe(12_000)
    expect(computeValidatorTimeoutMs(8)).toBe(16_000)
    expect(computeValidatorTimeoutMs(13)).toBe(26_000) // the 2026-04-14 incident
  })

  it('caps at 45s regardless of task count', () => {
    expect(computeValidatorTimeoutMs(25)).toBe(45_000)
    expect(computeValidatorTimeoutMs(50)).toBe(45_000)
    expect(computeValidatorTimeoutMs(999)).toBe(45_000)
  })

  it('handles degenerate inputs defensively', () => {
    expect(computeValidatorTimeoutMs(0)).toBe(10_000)
    expect(computeValidatorTimeoutMs(-5)).toBe(10_000)
  })
})

describe('validateDependencies', () => {
  let runSubagentSpy: ReturnType<typeof spyOn>
  let auditSpy: ReturnType<typeof spyOn>
  let stderrWrites: string[]
  let stderrSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    stderrWrites = []
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })
    auditSpy = spyOn(auditModule, 'appendAuditEntry').mockResolvedValue(undefined)
  })

  afterEach(() => {
    runSubagentSpy?.mockRestore()
    auditSpy?.mockRestore()
    stderrSpy?.mockRestore()
  })

  it('returns flags + writes success audit when LLM responds with valid JSON', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockResolvedValue({
      text: '```json\n{"flags":[{"taskId":"configure-tailwind","suggestedDep":"init-project","rationale":"Tailwind writes into project root that init-project creates"}]}\n```',
      messages: [],
      error: null,
    })
    const flags = await validateDependencies({ parent: makeParent(), tasks: twoTasks })
    expect(flags).toHaveLength(1)
    expect(flags[0].taskId).toBe('configure-tailwind')
    expect(flags[0].suggestedDep).toBe('init-project')
    expect(flags[0].rationale).toContain('init-project')
    expect(auditSpy).toHaveBeenCalledTimes(1)
    const auditArg = auditSpy.mock.calls[0][0]
    expect(auditArg.kind).toBe('dependency_validation')
    expect(auditArg.trigger).toBe('success')
    expect(auditArg.taskCount).toBe(2)
    expect(auditArg.flagCount).toBe(1)
  })

  it('returns [] + writes empty success audit when LLM responds with empty flags', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockResolvedValue({
      text: '```json\n{"flags":[]}\n```',
      messages: [],
      error: null,
    })
    const flags = await validateDependencies({ parent: makeParent(), tasks: twoTasks })
    expect(flags).toEqual([])
    expect(auditSpy.mock.calls[0][0].trigger).toBe('success')
    expect(auditSpy.mock.calls[0][0].flagCount).toBe(0)
  })

  it('returns [] + writes llm_error audit when runSubagent reports an error', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockResolvedValue({
      text: '',
      messages: [],
      error: new Error('Provider unavailable'),
    })
    const flags = await validateDependencies({ parent: makeParent(), tasks: twoTasks })
    expect(flags).toEqual([])
    expect(auditSpy.mock.calls[0][0].trigger).toBe('llm_error')
    expect(stderrWrites.join('')).toContain('LLM call failed')
  })

  it('returns [] + writes parse_error audit when output is not JSON', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockResolvedValue({
      text: 'I cannot help with that.',
      messages: [],
      error: null,
    })
    const flags = await validateDependencies({ parent: makeParent(), tasks: twoTasks })
    expect(flags).toEqual([])
    expect(auditSpy.mock.calls[0][0].trigger).toBe('parse_error')
  })

  it('returns [] + writes parse_error audit when JSON does not match schema', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockResolvedValue({
      text: '```json\n{"wrong":"shape"}\n```',
      messages: [],
      error: null,
    })
    const flags = await validateDependencies({ parent: makeParent(), tasks: twoTasks })
    expect(flags).toEqual([])
    expect(auditSpy.mock.calls[0][0].trigger).toBe('parse_error')
  })

  it('returns [] + writes timeout audit when runSubagent never resolves within timeoutMs', async () => {
    runSubagentSpy = spyOn(subagentModule, 'runSubagent').mockImplementation(
      () => new Promise(() => {}), // hangs forever
    )
    const flags = await validateDependencies({
      parent: makeParent(),
      tasks: twoTasks,
      timeoutMs: 50,
    })
    expect(flags).toEqual([])
    expect(auditSpy.mock.calls[0][0].trigger).toBe('timeout')
    expect(stderrWrites.join('')).toContain('timed out')
  }, 1000)
})
