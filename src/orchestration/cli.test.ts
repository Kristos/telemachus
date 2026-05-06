/**
 * Phase 40-01: Unit tests for the `tm orchestrate` CLI entry point.
 * Phase 44-02: Extended with --prompt and --cheap flag tests.
 * Phase 53-03: Extended with runWaveFailFastCliPrompt 3-way loop tests.
 *
 * Uses spyOn + dependency injection instead of mock.module to avoid
 * process-level mock contamination (mock.module('node:fs/promises') breaks
 * event-log.test.ts when run in the same bun test process).
 */

import { beforeEach, afterEach, describe, expect, it, spyOn, mock } from 'bun:test'
import { runOrchestrateSubcommand, runWaveFailFastCliPrompt } from './cli.js'
import type { WaveSnapshot } from './wave-fail-fast.js'
import * as engineModule from './engine.js'
import * as loaderModule from '../config/loader.js'
import * as providerModule from '../providers/registry.js'
import * as toolsModule from '../tools/builtin/index.js'
import * as templatesModule from './templates/index.js'
import * as decomposerModule from './decomposer.js'
import * as planApprovalModule from './plan-approval.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_DECOMPOSE_RESULT = {
  config: {
    schemaVersion: 1 as const,
    maxWorkerTurns: 20,
    maxRetries: 2,
    escalationTimeoutMinutes: 30,
    tasks: [
      { id: 'build-cli', prompt: 'Build a CLI tool', escalation: 'auto_accept' as const },
    ],
  },
  planText: 'Proposed Orchestration Plan (1 tasks)\n\n1. [build-cli] Build a CLI tool\n\nApprove this plan? (y/n)',
  warnings: [],
}

const VALID_CONFIG = JSON.stringify({
  schemaVersion: 1,
  tasks: [{ id: 'task-1', prompt: 'Do something', escalation: 'auto_accept' }],
})

const REQUIRE_HUMAN_CONFIG = JSON.stringify({
  schemaVersion: 1,
  tasks: [{ id: 'task-1', prompt: 'Do something', escalation: 'require_human' }],
})

function makeApprovedResult() {
  return {
    runId: 'run-1',
    taskResults: [
      { taskId: 'task-1', finalState: 'approved' as const, attempts: 1 },
    ],
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

let exitSpy: ReturnType<typeof spyOn>
let stdoutSpy: ReturnType<typeof spyOn>
let stderrSpy: ReturnType<typeof spyOn>
let engineSpy: ReturnType<typeof spyOn>
let loaderSpy: ReturnType<typeof spyOn>
let providerSpy: ReturnType<typeof spyOn>
let toolsSpy: ReturnType<typeof spyOn>
let getTemplateSpy: ReturnType<typeof spyOn>
let listTemplatesSpy: ReturnType<typeof spyOn>
let instantiateTemplateSpy: ReturnType<typeof spyOn>

const mockReadFile = mock(async (_p: string, _e: string) => VALID_CONFIG)

const MOCK_TEMPLATE_DEF = {
  name: 'nextjs-site',
  description: 'Next.js application with App Router',
  tasks: [{ id: 'init', prompt: 'Initialize project' }],
}

const MOCK_INSTANTIATED_CONFIG = {
  schemaVersion: 1 as const,
  tasks: [{ id: 'init', prompt: 'Initialize project', escalation: 'auto_accept' as const }],
}

beforeEach(() => {
  exitSpy = spyOn(process, 'exit').mockImplementation((_code?: number) => {
    throw new Error(`process.exit(${_code})`)
  })
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)

  engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue(makeApprovedResult())
  loaderSpy = spyOn(loaderModule, 'loadConfig').mockResolvedValue({
    provider: 'anthropic' as any,
    model: 'claude-sonnet-4-5',
    windowSize: 40,
    temperature: 0.7,
    maxIterations: 20,
    toolTimeoutMs: 30_000,
  } as any)
  providerSpy = spyOn(providerModule, 'createProvider').mockReturnValue({} as any)
  toolsSpy = spyOn(toolsModule, 'buildAllTools').mockReturnValue([] as any)
  getTemplateSpy = spyOn(templatesModule, 'getTemplate').mockReturnValue(MOCK_TEMPLATE_DEF as any)
  listTemplatesSpy = spyOn(templatesModule, 'listTemplates').mockReturnValue([
    { name: 'nextjs-site', description: 'Next.js application with App Router' },
    { name: 'rest-api', description: 'REST API with Express' },
  ])
  instantiateTemplateSpy = spyOn(templatesModule, 'instantiateTemplate').mockResolvedValue(MOCK_INSTANTIATED_CONFIG as any)

  mockReadFile.mockImplementation(async () => VALID_CONFIG)
})

afterEach(() => {
  exitSpy.mockRestore()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  engineSpy.mockRestore()
  loaderSpy.mockRestore()
  providerSpy.mockRestore()
  toolsSpy.mockRestore()
  getTemplateSpy.mockRestore()
  listTemplatesSpy.mockRestore()
  instantiateTemplateSpy.mockRestore()
})

const deps = { readFile: mockReadFile }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runOrchestrateSubcommand', () => {
  it('Test 1 — no args writes usage to stderr and exits 1', async () => {
    await expect(runOrchestrateSubcommand([], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('Usage')
    expect(stderrOutput).toContain('orchestrate')
  })

  it('Test 2 — invalid JSON file writes error to stderr and exits 1', async () => {
    mockReadFile.mockImplementation(async () => 'not valid json {{{')
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput.toLowerCase()).toMatch(/error|invalid|json/i)
  })

  it('Test 3 — non-existent file writes error to stderr and exits 1', async () => {
    mockReadFile.mockImplementation(async () => {
      throw new Error('ENOENT: no such file or directory')
    })
    await expect(runOrchestrateSubcommand(['bad.json'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('Error reading config')
  })

  it('Test 4 — valid config, all tasks approved → exits 0', async () => {
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(0)')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('Test 5 — valid config, task failed → exits 1', async () => {
    engineSpy.mockResolvedValue({
      runId: 'run-1',
      taskResults: [{ taskId: 'task-1', finalState: 'failed' as const, attempts: 1 }],
    })
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(1)')
  })

  it('Test 6 — valid config, task escalated → exits 1', async () => {
    engineSpy.mockResolvedValue({
      runId: 'run-1',
      taskResults: [{ taskId: 'task-1', finalState: 'escalated' as const, attempts: 1 }],
    })
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(1)')
  })

  it('Test 7 — onTaskTransition writes "[taskId] from -> to" to stdout', async () => {
    engineSpy.mockImplementation(async (_config: any, _parent: any, _runId: any, hooks: any) => {
      hooks?.onTaskTransition?.('task-1', 'queued', 'worker_running')
      hooks?.onTaskTransition?.('task-1', 'worker_running', 'review_pending')
      hooks?.onTaskTransition?.('task-1', 'reviewing', 'approved')
      return makeApprovedResult()
    })

    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(0)')

    const stdoutOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stdoutOutput).toContain('[task-1] queued -> worker_running')
    expect(stdoutOutput).toContain('[task-1] worker_running -> review_pending')
    expect(stdoutOutput).toContain('[task-1] reviewing -> approved')
  })

  it('Test 8 — escalated require_human task gets CLI-specific stderr warning', async () => {
    mockReadFile.mockImplementation(async () => REQUIRE_HUMAN_CONFIG)
    engineSpy.mockResolvedValue({
      runId: 'run-1',
      taskResults: [{ taskId: 'task-1', finalState: 'escalated' as const, attempts: 1 }],
    })
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('require_human tasks cannot be human-gated via CLI')
    expect(stderrOutput).toContain('task-1')
  })

  it('Test 9 — config validation error writes error to stderr and exits 1', async () => {
    mockReadFile.mockImplementation(async () =>
      JSON.stringify({ schemaVersion: 99, tasks: [] })
    )
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('Config validation error')
  })
})

describe('runOrchestrateSubcommand --template flag', () => {
  it('Test 10 — --template with valid name calls getTemplate, instantiateTemplate, then runs', async () => {
    await expect(runOrchestrateSubcommand(['--template', 'nextjs-site'], deps)).rejects.toThrow('process.exit(0)')
    expect(getTemplateSpy).toHaveBeenCalledWith('nextjs-site')
    expect(instantiateTemplateSpy).toHaveBeenCalled()
    expect(engineSpy).toHaveBeenCalled()
  })

  it('Test 11 — --template with unknown name writes error + available templates to stderr and exits 1', async () => {
    getTemplateSpy.mockReturnValue(undefined)
    await expect(runOrchestrateSubcommand(['--template', 'nonexistent'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('nonexistent')
    expect(stderrOutput).toMatch(/nextjs-site|rest-api|available/i)
  })

  it('Test 12 — --template with no name writes usage to stderr and exits 1', async () => {
    await expect(runOrchestrateSubcommand(['--template'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toMatch(/usage|template/i)
  })

  it('Test 13 — --template runtime check failure writes error to stderr and exits 1', async () => {
    instantiateTemplateSpy.mockRejectedValue(new Error('Template "nextjs-site" requires Node.js runtime but runtime check failed'))
    await expect(runOrchestrateSubcommand(['--template', 'nextjs-site'], deps)).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('runtime check failed')
  })

  it('Test 14 — existing config.json path is unchanged (backward compatible)', async () => {
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(0)')
    // Template functions should not be called for normal config file path
    expect(getTemplateSpy).not.toHaveBeenCalled()
    expect(instantiateTemplateSpy).not.toHaveBeenCalled()
  })
})

// ── --prompt and --cheap flag tests ──────────────────────────────────────────

describe('runOrchestrateSubcommand --prompt flag', () => {
  let decomposeSpy: ReturnType<typeof spyOn>
  let awaitPlanApprovalSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    decomposeSpy = spyOn(decomposerModule, 'decompose').mockResolvedValue(MOCK_DECOMPOSE_RESULT as any)
    awaitPlanApprovalSpy = spyOn(planApprovalModule, 'awaitPlanApproval').mockResolvedValue('approved')
  })

  afterEach(() => {
    decomposeSpy.mockRestore()
    awaitPlanApprovalSpy.mockRestore()
  })

  it('Test P1 — --prompt calls decompose with the prompt string', async () => {
    const mockConfirmFn = mock(async () => true)
    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(decomposeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'build a CLI tool', modelOverride: undefined })
    )
  })

  it('Test P2 — approval gate returning rejected exits cleanly without calling runOrchestration', async () => {
    awaitPlanApprovalSpy.mockResolvedValue('rejected')
    const mockConfirmFn = mock(async () => false)

    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(engineSpy).not.toHaveBeenCalled()
    const stdoutOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stdoutOutput).toContain('Plan rejected')
  })

  it('Test P3 — approval gate returning approved calls runOrchestration', async () => {
    const mockConfirmFn = mock(async () => true)

    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(engineSpy).toHaveBeenCalled()
  })

  it('Test P4 — --cheap passes modelOverride to decompose', async () => {
    const mockConfirmFn = mock(async () => true)

    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool', '--cheap'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(decomposeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: { provider: 'openai-compat', model: 'glm-4.7-flash' },
      })
    )
  })

  it('Test P5 — --cheap overrides all task model/provider fields to GLM before running', async () => {
    const mockConfirmFn = mock(async () => true)
    const capturedConfigs: any[] = []
    engineSpy.mockImplementation(async (cfg: any) => {
      capturedConfigs.push(cfg)
      return makeApprovedResult()
    })

    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool', '--cheap'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(capturedConfigs).toHaveLength(1)
    const passedConfig = capturedConfigs[0]
    for (const task of passedConfig.tasks) {
      expect(task.provider).toBe('openai-compat')
      expect(task.model).toBe('glm-4.7-flash')
    }
  })

  it('Test P6 — default mode (no --cheap) does NOT override task model/provider fields', async () => {
    const mockConfirmFn = mock(async () => true)
    const capturedConfigs: any[] = []
    engineSpy.mockImplementation(async (cfg: any) => {
      capturedConfigs.push(cfg)
      return makeApprovedResult()
    })

    await expect(
      runOrchestrateSubcommand(['--prompt', 'build a CLI tool'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
        confirmFn: mockConfirmFn,
      })
    ).rejects.toThrow('process.exit(0)')

    expect(capturedConfigs).toHaveLength(1)
    const passedConfig = capturedConfigs[0]
    for (const task of passedConfig.tasks) {
      // Original config has no provider/model set
      expect(task.provider).toBeUndefined()
      expect(task.model).toBeUndefined()
    }
  })

  it('Test P7 — --prompt missing value writes usage to stderr and exits 1', async () => {
    await expect(
      runOrchestrateSubcommand(['--prompt'], {
        ...deps,
        decomposeFn: decomposeSpy as any,
        awaitPlanApprovalFn: awaitPlanApprovalSpy as any,
      })
    ).rejects.toThrow('process.exit(1)')
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).toContain('Usage')
    expect(stderrOutput).toContain('--prompt')
  })

  it('Test P8 — existing argv ["config.json"] path still works unchanged', async () => {
    await expect(runOrchestrateSubcommand(['config.json'], deps)).rejects.toThrow('process.exit(0)')
    expect(decomposeSpy).not.toHaveBeenCalled()
    expect(awaitPlanApprovalSpy).not.toHaveBeenCalled()
  })

  it('Test P9 — existing argv ["--template", "cli-tool"] path still works unchanged', async () => {
    await expect(runOrchestrateSubcommand(['--template', 'nextjs-site'], deps)).rejects.toThrow('process.exit(0)')
    expect(decomposeSpy).not.toHaveBeenCalled()
    expect(awaitPlanApprovalSpy).not.toHaveBeenCalled()
  })
})

// ── Phase 53-03: runWaveFailFastCliPrompt 3-way decision loop ─────────────────

describe('runWaveFailFastCliPrompt — 3-way decision loop', () => {
  const mkSnapshot = (overrides?: Partial<WaveSnapshot>): WaveSnapshot => ({
    waveNumber: 1,
    totalTasks: 2,
    failedTasks: [
      { id: 'task-a', errorExcerpt: 'spawn ENOENT' },
      { id: 'task-b', errorExcerpt: 'timeout' },
    ],
    threshold: 0.5,
    rate: 1.0,
    formatInspection: () => 'INSPECTION_TEXT',
    ...overrides,
  })

  const mkIo = (answers: string[]) => {
    let i = 0
    const printed: string[] = []
    return {
      io: {
        readLine: async (_prompt: string) => answers[i++] ?? '',
        print: (text: string) => {
          printed.push(text)
        },
      },
      printed,
    }
  }

  it("'c' returns 'continue'", async () => {
    const { io } = mkIo(['c'])
    expect(await runWaveFailFastCliPrompt(mkSnapshot(), io)).toBe('continue')
  })

  it("'continue' (full word) returns 'continue'", async () => {
    const { io } = mkIo(['continue'])
    expect(await runWaveFailFastCliPrompt(mkSnapshot(), io)).toBe('continue')
  })

  it("'a' returns 'abort'", async () => {
    const { io } = mkIo(['a'])
    expect(await runWaveFailFastCliPrompt(mkSnapshot(), io)).toBe('abort')
  })

  it("'abort' (full word) returns 'abort'", async () => {
    const { io } = mkIo(['abort'])
    expect(await runWaveFailFastCliPrompt(mkSnapshot(), io)).toBe('abort')
  })

  it("'i' prints inspection then re-prompts; subsequent 'c' returns 'continue'", async () => {
    const { io, printed } = mkIo(['i', 'c'])
    const decision = await runWaveFailFastCliPrompt(mkSnapshot(), io)
    expect(decision).toBe('continue')
    expect(printed.some((p) => p === 'INSPECTION_TEXT')).toBe(true)
  })

  it('invalid input re-prompts; subsequent valid input completes', async () => {
    const { io, printed } = mkIo(['xyz', 'a'])
    const decision = await runWaveFailFastCliPrompt(mkSnapshot(), io)
    expect(decision).toBe('abort')
    expect(printed.some((p) => p.includes('Invalid input'))).toBe(true)
  })

  it('header includes wave number, failed count, rate, threshold', async () => {
    const { io, printed } = mkIo(['c'])
    await runWaveFailFastCliPrompt(mkSnapshot({ waveNumber: 3 }), io)
    const headerLine = printed.find((p) => p.includes('[wave 3]')) ?? ''
    expect(headerLine).toContain('2/2 tasks failed')
    expect(headerLine).toContain('rate 1.00')
    expect(headerLine).toContain('threshold 0.5')
  })
})
