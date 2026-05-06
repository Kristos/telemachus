/**
 * Phase 40-02: Unit tests for Discord orchestrate command handler.
 * Phase 44-02: Extended with freeform NL and --cheap flag tests.
 * Phase 53-03: Extended with runWaveFailFastDiscordPrompt and resolveWaveFailFastReply tests.
 * Phase 54-01: Extended with buildOrchestrationSummary unit tests + ConversationManager integration tests.
 *
 * Uses spyOn instead of mock.module to avoid process-level mock contamination
 * that breaks other test files when run together (Bun's mock.module is global).
 */

import { beforeEach, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { DiscordMessage } from '../discord/runner.js'
import { ConversationManager } from '../discord/conversation.js'
import * as templatesModule from './templates/index.js'
import * as decomposerModule from './decomposer.js'
import * as planApprovalModule from './plan-approval.js'
import type { WaveSnapshot } from './wave-fail-fast.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(content: string): DiscordMessage & { _replies: string[] } {
  const replies: string[] = []
  return {
    channelId: 'chan-123',
    content,
    authorId: 'user-456',
    _replies: replies,
    reply: mock(async (text: string) => {
      replies.push(text)
    }),
    sendTyping: mock(async () => {}),
    isGuild: false,
    isThread: false,
  }
}

const VALID_CONFIG = JSON.stringify({
  schemaVersion: 1,
  tasks: [{ id: 'task-1', prompt: 'Do something' }],
})

const MOCK_DECOMPOSE_RESULT = {
  config: {
    schemaVersion: 1 as const,
    maxWorkerTurns: 20,
    maxRetries: 2,
    escalationTimeoutMinutes: 30,
    tasks: [
      { id: 'build-api', prompt: 'Build a REST API', escalation: 'auto_accept' as const },
    ],
  },
  planText: 'Proposed Orchestration Plan (1 tasks)\n\n1. [build-api] Build a REST API\n\nApprove this plan? (y/n)',
  warnings: [],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleOrchestrateCommand', () => {
  // We import the real module and spy on runOrchestration from engine.ts
  let handleOrchestrateCommand: typeof import('./discord.js').handleOrchestrateCommand
  let engineModule: typeof import('./engine.js')
  let decomposeSpy: ReturnType<typeof spyOn>
  let awaitPlanApprovalSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    // Fresh imports
    engineModule = await import('./engine.js')
    const discordModule = await import('./discord.js')
    handleOrchestrateCommand = discordModule.handleOrchestrateCommand

    // Stub decompose + awaitPlanApproval to prevent real LLM calls in tests
    // that accidentally trigger the freeform path
    decomposeSpy = spyOn(decomposerModule, 'decompose').mockResolvedValue(MOCK_DECOMPOSE_RESULT as any)
    awaitPlanApprovalSpy = spyOn(planApprovalModule, 'awaitPlanApproval').mockResolvedValue('approved')
  })

  afterEach(() => {
    decomposeSpy.mockRestore()
    awaitPlanApprovalSpy.mockRestore()
  })

  it('Test 1 — plain English routes to freeform handler and decomposes', async () => {
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [{ taskId: 'build-api', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg('!orchestrate build a REST API')
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    expect(decomposeSpy).toHaveBeenCalled()
    expect(msg._replies[0]).toContain('Decomposing')
    engineSpy.mockRestore()
  })

  it('Test 3 — schema validation failure replies with truncated error', async () => {
    const badConfig = JSON.stringify({ schemaVersion: 1 })
    const msg = makeMsg(`!orchestrate ${badConfig}`)

    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    expect(msg._replies).toHaveLength(1)
    expect(msg._replies[0]).toMatch(/Config error:/)
    expect(msg._replies[0].length).toBeLessThanOrEqual(1520)
  })

  it('Test 2 — valid JSON calls runOrchestration and replies with confirmation', async () => {
    // Spy on runOrchestration to intercept the real call
    const spy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [{ taskId: 'task-1', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    // Wait for fire-and-forget
    await new Promise(r => setTimeout(r, 100))

    expect(msg._replies[0]).toMatch(/Orchestration started/)
    expect(msg._replies[0]).toMatch(/1 task/)
    spy.mockRestore()
  })

  it('Test 5 — completion message includes summary of results', async () => {
    const spy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [
        { taskId: 'task-1', finalState: 'approved' as const, attempts: 1 },
        { taskId: 'task-2', finalState: 'failed' as const, attempts: 2 },
        { taskId: 'task-3', finalState: 'escalated' as const, attempts: 3 },
      ],
    })

    const multiConfig = JSON.stringify({
      schemaVersion: 1,
      tasks: [
        { id: 'task-1', prompt: 'Do 1' },
        { id: 'task-2', prompt: 'Do 2' },
        { id: 'task-3', prompt: 'Do 3' },
      ],
    })

    const msg = makeMsg(`!orchestrate ${multiConfig}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    const lastReply = msg._replies[msg._replies.length - 1]
    expect(lastReply).toMatch(/Orchestration complete/)
    expect(lastReply).toMatch(/1 approved/)
    expect(lastReply).toMatch(/1 failed/)
    expect(lastReply).toMatch(/1 escalated/)
    spy.mockRestore()
  })

  it('Test 4 — onTaskTransition posts only significant transitions', async () => {
    const spy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, _parent, _runId, hooks) => {
        hooks?.onTaskTransition?.('task-1', 'queued', 'worker_running')
        hooks?.onTaskTransition?.('task-1', 'worker_running', 'review_pending')
        hooks?.onTaskTransition?.('task-1', 'review_pending', 'reviewing')
        hooks?.onTaskTransition?.('task-1', 'reviewing', 'approved')
        return {
          runId: 'test-run-id',
          taskResults: [{ taskId: 'task-1', finalState: 'approved' as const, attempts: 1 }],
        }
      },
    )

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    const replyTexts = msg._replies
    expect(replyTexts[0]).toMatch(/Orchestration started/)

    const transitionReplies = replyTexts.slice(1, -1)
    expect(transitionReplies.some(r => r.includes('worker_running'))).toBe(true)
    expect(transitionReplies.some(r => r.includes('reviewing'))).toBe(true)
    expect(transitionReplies.some(r => r.includes('approved'))).toBe(true)
    expect(transitionReplies.some(r => r.includes('review_pending'))).toBe(false)
    spy.mockRestore()
  })

  it('Test 6 — status messages exceeding 2000 chars are chunked', async () => {
    const spy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, _parent, _runId, hooks) => {
        const longTaskId = 'task-' + 'x'.repeat(2100)
        hooks?.onTaskTransition?.('task-1', 'queued', 'worker_running', {
          someData: longTaskId,
        })
        return {
          runId: 'test-run-id',
          taskResults: [{ taskId: 'task-1', finalState: 'approved' as const, attempts: 1 }],
        }
      },
    )

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    for (const reply of msg._replies) {
      expect(reply.length).toBeLessThanOrEqual(2000)
    }
    spy.mockRestore()
  })
})

describe('handleListTemplatesCommand', () => {
  let handleListTemplatesCommand: typeof import('./discord.js').handleListTemplatesCommand
  let listTemplatesSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    const discordModule = await import('./discord.js')
    handleListTemplatesCommand = discordModule.handleListTemplatesCommand
    listTemplatesSpy = spyOn(templatesModule, 'listTemplates').mockReturnValue([
      { name: 'nextjs-site', description: 'Next.js application with App Router' },
      { name: 'rest-api', description: 'REST API with Express' },
      { name: 'cli-tool', description: 'CLI tool with TypeScript' },
    ])
  })

  it('Test T1 — replies with a numbered list of template names and descriptions', async () => {
    const msg = makeMsg('!orchestrate-templates')
    await handleListTemplatesCommand(msg)

    expect(msg._replies).toHaveLength(1)
    expect(msg._replies[0]).toContain('nextjs-site')
    expect(msg._replies[0]).toContain('rest-api')
    expect(msg._replies[0]).toContain('cli-tool')
    expect(msg._replies[0]).toContain('Next.js application')
    listTemplatesSpy.mockRestore()
  })
})

describe('handleOrchestrateTemplateCommand', () => {
  let handleOrchestrateTemplateCommand: typeof import('./discord.js').handleOrchestrateTemplateCommand
  let engineModule: typeof import('./engine.js')
  let getTemplateSpy: ReturnType<typeof spyOn>
  let listTemplatesSpy: ReturnType<typeof spyOn>
  let instantiateTemplateSpy: ReturnType<typeof spyOn>

  const MOCK_TEMPLATE_DEF = {
    name: 'nextjs-site',
    description: 'Next.js application with App Router',
    tasks: [{ id: 'init', prompt: 'Initialize project' }],
  }

  const MOCK_INSTANTIATED_CONFIG = {
    schemaVersion: 1,
    tasks: [{ id: 'init', prompt: 'Initialize project', escalation: 'auto_accept' }],
  }

  beforeEach(async () => {
    engineModule = await import('./engine.js')
    const discordModule = await import('./discord.js')
    handleOrchestrateTemplateCommand = discordModule.handleOrchestrateTemplateCommand
    getTemplateSpy = spyOn(templatesModule, 'getTemplate').mockReturnValue(MOCK_TEMPLATE_DEF as any)
    listTemplatesSpy = spyOn(templatesModule, 'listTemplates').mockReturnValue([
      { name: 'nextjs-site', description: 'Next.js application with App Router' },
      { name: 'rest-api', description: 'REST API with Express' },
    ])
    instantiateTemplateSpy = spyOn(templatesModule, 'instantiateTemplate').mockResolvedValue(MOCK_INSTANTIATED_CONFIG as any)
  })

  it('Test T2 — valid template name replies with confirmation and runs orchestration', async () => {
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'run-1',
      taskResults: [{ taskId: 'init', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg('!orchestrate-template nextjs-site')
    await handleOrchestrateTemplateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    expect(getTemplateSpy).toHaveBeenCalledWith('nextjs-site')
    expect(instantiateTemplateSpy).toHaveBeenCalled()
    const replyTexts = msg._replies.join(' ')
    expect(replyTexts).toMatch(/nextjs-site|Starting|template/i)
    engineSpy.mockRestore()
    getTemplateSpy.mockRestore()
    listTemplatesSpy.mockRestore()
    instantiateTemplateSpy.mockRestore()
  })

  it('Test T3 — unknown template name replies with error listing available templates', async () => {
    getTemplateSpy.mockReturnValue(undefined)

    const msg = makeMsg('!orchestrate-template nonexistent')
    await handleOrchestrateTemplateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    expect(msg._replies).toHaveLength(1)
    expect(msg._replies[0]).toMatch(/nonexistent|Unknown|template/i)
    expect(msg._replies[0]).toMatch(/nextjs-site|rest-api/i)
    getTemplateSpy.mockRestore()
    listTemplatesSpy.mockRestore()
    instantiateTemplateSpy.mockRestore()
  })

  it('Test T4 — runtime check failure replies with error message', async () => {
    instantiateTemplateSpy.mockRejectedValue(new Error('Template "nextjs-site" requires Node.js but runtime check failed'))

    const msg = makeMsg('!orchestrate-template nextjs-site')
    await handleOrchestrateTemplateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 50))

    const allReplies = msg._replies.join(' ')
    expect(allReplies).toMatch(/runtime check failed|error/i)
    getTemplateSpy.mockRestore()
    listTemplatesSpy.mockRestore()
    instantiateTemplateSpy.mockRestore()
  })
})

describe('isCommand for template commands', () => {
  it('Test T5 — isCommand returns true for !orchestrate-templates', async () => {
    const { isCommand } = await import('../discord/commands.js')
    expect(isCommand('!orchestrate-templates')).toBe(true)
  })

  it('Test T6 — isCommand returns true for !orchestrate-template nextjs-site', async () => {
    const { isCommand } = await import('../discord/commands.js')
    expect(isCommand('!orchestrate-template nextjs-site')).toBe(true)
  })
})

// ── Freeform orchestration tests (Phase 44-02) ────────────────────────────────

describe('handleFreeformOrchestrateCommand', () => {
  let handleOrchestrateCommand: typeof import('./discord.js').handleOrchestrateCommand
  let handleFreeformOrchestrateCommand: typeof import('./discord.js').handleFreeformOrchestrateCommand
  let resolvePendingPlanApproval: typeof import('./discord.js').resolvePendingPlanApproval
  let engineModule: typeof import('./engine.js')
  let decomposeSpy: ReturnType<typeof spyOn>
  let awaitPlanApprovalSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    engineModule = await import('./engine.js')
    const discordModule = await import('./discord.js')
    handleOrchestrateCommand = discordModule.handleOrchestrateCommand
    handleFreeformOrchestrateCommand = discordModule.handleFreeformOrchestrateCommand
    resolvePendingPlanApproval = discordModule.resolvePendingPlanApproval

    decomposeSpy = spyOn(decomposerModule, 'decompose').mockResolvedValue(MOCK_DECOMPOSE_RESULT as any)
    awaitPlanApprovalSpy = spyOn(planApprovalModule, 'awaitPlanApproval').mockResolvedValue('approved')
  })

  afterEach(() => {
    decomposeSpy.mockRestore()
    awaitPlanApprovalSpy.mockRestore()
  })

  it('Test F1 — JSON path still works when valid JSON is detected', async () => {
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [{ taskId: 'task-1', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    // decompose should NOT be called for JSON path
    expect(decomposeSpy).not.toHaveBeenCalled()
    expect(msg._replies[0]).toMatch(/Orchestration started/)
    engineSpy.mockRestore()
  })

  it('Test F2 — freeform path calls decompose and awaitPlanApproval', async () => {
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [{ taskId: 'build-api', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg('!orchestrate build a REST API')
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    expect(decomposeSpy).toHaveBeenCalled()
    expect(awaitPlanApprovalSpy).toHaveBeenCalled()
    engineSpy.mockRestore()
  })

  it('Test F3 — --cheap flag extracted and passed to decompose as modelOverride', async () => {
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [{ taskId: 'build-api', finalState: 'approved' as const, attempts: 1 }],
    })

    const msg = makeMsg('!orchestrate --cheap build a REST API')
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    expect(decomposeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: { provider: 'openai-compat', model: 'glm-4.7-flash' },
      })
    )
    engineSpy.mockRestore()
  })

  it('Test F4 — rejection at approval gate replies "Plan cancelled." and does not run orchestration', async () => {
    awaitPlanApprovalSpy.mockResolvedValue('rejected')
    const engineSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'test-run-id',
      taskResults: [],
    })

    const msg = makeMsg('!orchestrate build a REST API')
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    await new Promise(r => setTimeout(r, 100))

    expect(engineSpy).not.toHaveBeenCalled()
    const allReplies = msg._replies.join(' ')
    expect(allReplies).toContain('Plan cancelled')
    engineSpy.mockRestore()
  })

  it('Test F5 — isCommand returns true for freeform !orchestrate <english>', async () => {
    const { isCommand } = await import('../discord/commands.js')
    expect(isCommand('!orchestrate build a REST API')).toBe(true)
  })

  it('Test F6 — resolvePendingPlanApproval returns false when no pending approval', async () => {
    const { resolvePendingPlanApproval: resolve } = await import('./discord.js')
    const consumed = resolve('yes')
    expect(consumed).toBe(false)
  })
})

// ── Phase 53-03: runWaveFailFastDiscordPrompt 3-way decision loop ─────────────

describe('runWaveFailFastDiscordPrompt — 3-way decision loop', () => {
  const mkSnapshot = (overrides?: Partial<WaveSnapshot>): WaveSnapshot => ({
    waveNumber: 1,
    totalTasks: 2,
    failedTasks: [
      { id: 'a', errorExcerpt: 'err1' },
      { id: 'b', errorExcerpt: 'err2' },
    ],
    threshold: 0.5,
    rate: 1.0,
    formatInspection: () => 'FAILED_TASKS_INSPECTION',
    ...overrides,
  })

  it("'continue' reply returns 'continue' and posts summary header", async () => {
    const { runWaveFailFastDiscordPrompt } = await import('./discord.js')
    const posts: string[] = []
    const decision = await runWaveFailFastDiscordPrompt(mkSnapshot(), {
      post: async (t) => {
        posts.push(t)
      },
      awaitReply: async () => 'continue',
    })
    expect(decision).toBe('continue')
    expect(posts.some((p) => p.includes('Wave 1 fail-fast triggered'))).toBe(true)
  })

  it("'abort' reply returns 'abort'", async () => {
    const { runWaveFailFastDiscordPrompt } = await import('./discord.js')
    const decision = await runWaveFailFastDiscordPrompt(mkSnapshot(), {
      post: async () => {},
      awaitReply: async () => 'abort',
    })
    expect(decision).toBe('abort')
  })

  it("'inspect' then 'continue' posts inspection text and loops back", async () => {
    const { runWaveFailFastDiscordPrompt } = await import('./discord.js')
    const posts: string[] = []
    let callIdx = 0
    const replies: ('continue' | 'abort' | 'inspect')[] = ['inspect', 'continue']
    const decision = await runWaveFailFastDiscordPrompt(mkSnapshot(), {
      post: async (t) => {
        posts.push(t)
      },
      awaitReply: async () => replies[callIdx++],
    })
    expect(decision).toBe('continue')
    expect(posts.some((p) => p === 'FAILED_TASKS_INSPECTION')).toBe(true)
    // Two prompt rounds: header posted twice
    const headerCount = posts.filter((p) => p.includes('Wave 1 fail-fast triggered')).length
    expect(headerCount).toBe(2)
  })
})

// ── Phase 53-03: resolveWaveFailFastReply content mapping ────────────────────

describe('resolveWaveFailFastReply — content mapping', () => {
  it('returns false when no pending prompt', async () => {
    const { resolveWaveFailFastReply } = await import('./discord.js')
    expect(resolveWaveFailFastReply('continue')).toBe(false)
  })

  it('returns false for unknown content when no pending prompt', async () => {
    const { resolveWaveFailFastReply } = await import('./discord.js')
    expect(resolveWaveFailFastReply('xyz')).toBe(false)
    expect(resolveWaveFailFastReply('')).toBe(false)
    expect(resolveWaveFailFastReply('  HELP  ')).toBe(false)
  })
})

// ── Phase 54-01: buildOrchestrationSummary unit tests ────────────────────────

describe('buildOrchestrationSummary', () => {
  it('Test A — happy path with mixed results: truncates long runId, formats failed list with first-line excerpts', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: 'run-abc12345',
      taskResults: [
        { taskId: 'a', finalState: 'approved' as const, attempts: 1 },
        { taskId: 'b', finalState: 'failed' as const, attempts: 1, error: 'boom' },
        { taskId: 'c', finalState: 'failed' as const, attempts: 1, error: 'kaboom\nline2' },
      ],
    })
    expect(result).toBe('Orchestration [run-abc1] complete: 1 approved, 2 failed. Failed: [b (boom), c (kaboom)].')
  })

  it('Test B — all approved: runId ≤ 8 chars passed through, Failed list always present', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: 'short',
      taskResults: [
        { taskId: 'a', finalState: 'approved' as const, attempts: 1 },
        { taskId: 'b', finalState: 'approved' as const, attempts: 1 },
      ],
    })
    expect(result).toBe('Orchestration [short] complete: 2 approved, 0 failed. Failed: [].')
  })

  it('Test C — zero tasks: returns defensive no-tasks-executed message', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: 'abc',
      taskResults: [],
    })
    expect(result).toBe('Orchestration [abc] complete: no tasks executed.')
  })

  it('Test D — failed task with undefined error: formatErrorExcerpt returns empty, still emits parens', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: 'r',
      taskResults: [
        { taskId: 'x', finalState: 'failed' as const, attempts: 1, error: undefined },
      ],
    })
    expect(result).toBe('Orchestration [r] complete: 0 approved, 1 failed. Failed: [x ()].')
  })

  it('Test E — escalated/rejected/canceled states excluded from both counts and failed list', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: 'r',
      taskResults: [
        { taskId: 'a', finalState: 'approved' as const, attempts: 1 },
        { taskId: 'b', finalState: 'escalated' as const, attempts: 1 },
        { taskId: 'c', finalState: 'rejected' as const, attempts: 1 },
      ],
    })
    expect(result).toBe('Orchestration [r] complete: 1 approved, 0 failed. Failed: [].')
  })

  it('Test F — runId exactly 8 chars: no truncation at the 8-char boundary', async () => {
    const { buildOrchestrationSummary } = await import('./discord.js')
    const result = buildOrchestrationSummary({
      runId: '12345678',
      taskResults: [],
    })
    expect(result).toBe('Orchestration [12345678] complete: no tasks executed.')
  })
})

// ── Phase 54-01: OrchestrateCommandDeps and CommandDeps type shape tests ─────

describe('OrchestrateCommandDeps type — conversations field', () => {
  it('Test G — OrchestrateCommandDeps accepts conversations?: ConversationManager without TS error', async () => {
    const { } = await import('./discord.js')
    const conversations = new ConversationManager()
    // If TypeScript compiles this block, the type shape is correct.
    const _check: import('./discord.js').OrchestrateCommandDeps = {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      conversations,
    }
    expect(_check.conversations).toBe(conversations)
  })

  it('Test H — CommandDeps in commands.ts accepts conversations?: ConversationManager', async () => {
    const conversations = new ConversationManager()
    // If TypeScript compiles this, the type is wired correctly.
    const _check: import('../discord/commands.js').CommandDeps = {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      onJobComplete: async () => {},
      conversations,
    }
    expect(_check.conversations).toBe(conversations)
  })
})

// ── Phase 54-01: runOrchestrateDiscord → ConversationManager integration ─────

describe('runOrchestrateDiscord → ConversationManager integration (Phase 54)', () => {
  let engineModule: typeof import('./engine.js')
  let runOrchestrationSpy: ReturnType<typeof spyOn>
  let handleOrchestrateCommand: typeof import('./discord.js').handleOrchestrateCommand
  let conversations: ConversationManager
  let decomposeSpy: ReturnType<typeof spyOn>
  let awaitPlanApprovalSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    engineModule = await import('./engine.js')
    const discordModule = await import('./discord.js')
    handleOrchestrateCommand = discordModule.handleOrchestrateCommand
    conversations = new ConversationManager()

    // Stub decompose + awaitPlanApproval to avoid LLM calls on freeform path
    decomposeSpy = spyOn(decomposerModule, 'decompose').mockResolvedValue(MOCK_DECOMPOSE_RESULT as any)
    awaitPlanApprovalSpy = spyOn(planApprovalModule, 'awaitPlanApproval').mockResolvedValue('approved')
  })

  afterEach(() => {
    runOrchestrationSpy?.mockRestore()
    decomposeSpy?.mockRestore()
    awaitPlanApprovalSpy?.mockRestore()
  })

  it('Test I — happy path: appends structured assistant turn after successful run', async () => {
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'run-happy123',
      taskResults: [
        { taskId: 'a', finalState: 'approved' as const, attempts: 1 },
        { taskId: 'b', finalState: 'failed' as const, attempts: 1, error: 'boom' },
      ],
    })

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      conversations,
    })

    await new Promise(r => setTimeout(r, 100))

    const history = conversations.getHistory('chan-123')
    const assistantTurns = history.filter(h => h.role === 'assistant')
    expect(assistantTurns.length).toBeGreaterThan(0)
    const lastTurn = assistantTurns[assistantTurns.length - 1]
    expect(lastTurn.content).toBe('Orchestration [run-happ] complete: 1 approved, 1 failed. Failed: [b (boom)].')
    // Summary is the last message in history
    expect(history[history.length - 1].role).toBe('assistant')
  })

  it('Test J — catastrophic failure: appends failure assistant turn', async () => {
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockRejectedValue(new Error('decomposer exploded'))

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      conversations,
    })

    await new Promise(r => setTimeout(r, 100))

    const history = conversations.getHistory('chan-123')
    const assistantTurns = history.filter(h => h.role === 'assistant')
    expect(assistantTurns.length).toBeGreaterThan(0)
    const lastTurn = assistantTurns[assistantTurns.length - 1]
    expect(lastTurn.content).toMatch(/^Orchestration \[.+\] failed: decomposer exploded$/)
    // Verify msg.reply was still called (original behavior preserved)
    const replies = (msg as any)._replies as string[]
    expect(replies.some(r => r.includes('Orchestration failed'))).toBe(true)
  })

  it('Test K — canonical "Done?" end-to-end history shape', async () => {
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'done-flow',
      taskResults: [
        { taskId: 'x', finalState: 'approved' as const, attempts: 1 },
      ],
    })

    // Seed prior user message (simulates the message that triggered orchestration)
    conversations.addUserMessage('chan-123', 'go build a todo app')

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      conversations,
    })

    await new Promise(r => setTimeout(r, 100))

    const history = conversations.getHistory('chan-123')
    // History should contain: [user: 'go build a todo app', assistant: orchestration summary]
    expect(history[0]).toEqual({ role: 'user', content: 'go build a todo app' })
    expect(history[1]).toEqual({
      role: 'assistant',
      content: 'Orchestration [done-flo] complete: 1 approved, 0 failed. Failed: [].',
    })

    // Simulate subsequent chat turn — what runner.ts builds as priorHistory
    conversations.addUserMessage('chan-123', 'Done?')
    const nextHistory = conversations.getHistory('chan-123')
    // priorHistory = everything before current user message (what runner.ts sends as initialMessages)
    const priorHistory = nextHistory.slice(0, -1)
    // priorHistory contains the orchestration summary as an assistant turn
    const hasSummary = priorHistory.some(
      m => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Orchestration')
    )
    expect(hasSummary).toBe(true)
  })

  it('Test L — conversations absent (undefined) does not crash, reply still posts', async () => {
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'r',
      taskResults: [],
    })

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    // No conversations field
    await expect(handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })).resolves.toBeUndefined()

    await new Promise(r => setTimeout(r, 100))

    const replies = (msg as any)._replies as string[]
    expect(replies.some(r => r.includes('Orchestration started'))).toBe(true)
  })

  it('Test M — zero-task edge: appends "no tasks executed" message', async () => {
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockResolvedValue({
      runId: 'empty',
      taskResults: [],
    })

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
      conversations,
    })

    await new Promise(r => setTimeout(r, 100))

    const history = conversations.getHistory('chan-123')
    const lastMsg = history[history.length - 1]
    expect(lastMsg?.content).toBe('Orchestration [empty] complete: no tasks executed.')
  })
})

// ── Phase 60-04 Task 1: parentContext threading ──────────────────────────────

describe('parentContext threading (Phase 60)', () => {
  let engineModule: typeof import('./engine.js')
  let runOrchestrationSpy: ReturnType<typeof spyOn>
  let runOrchestrateDiscord: typeof import('./discord.js').runOrchestrateDiscord

  beforeEach(async () => {
    engineModule = await import('./engine.js')
    const discordModule = await import('./discord.js')
    runOrchestrateDiscord = discordModule.runOrchestrateDiscord
  })

  afterEach(() => {
    runOrchestrationSpy?.mockRestore()
  })

  it('Phase 60 Test 1 — parentContext undefined → SubagentParent.initialContext is undefined', async () => {
    let capturedParent: any = null
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, parent) => {
        capturedParent = parent
        return { runId: 'r', taskResults: [] }
      },
    )

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    // Call runOrchestrateDiscord directly with 5 args (parentContext omitted)
    await runOrchestrateDiscord(
      msg as any,
      JSON.parse(VALID_CONFIG) as any,
      { config: {} as any, provider: {} as any, registry: {} as any },
      undefined,
      undefined,
    )

    expect(capturedParent).not.toBeNull()
    expect(capturedParent.initialContext).toBeUndefined()
  })

  it('Phase 60 Test 2 — parentContext.messages flows to SubagentParent.initialContext by reference', async () => {
    let capturedParent: any = null
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, parent) => {
        capturedParent = parent
        return { runId: 'r', taskResults: [] }
      },
    )

    const messages = [{ role: 'user' as const, content: 'hi' }]
    const parentContext = { messages }

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await runOrchestrateDiscord(
      msg as any,
      JSON.parse(VALID_CONFIG) as any,
      { config: {} as any, provider: {} as any, registry: {} as any },
      undefined,
      undefined,
      parentContext,
    )

    expect(capturedParent).not.toBeNull()
    // Reference identity preserved through plumbing (no double-clone)
    expect(capturedParent.initialContext).toBe(messages)
  })

  it('Phase 60 Test 3 — runOrchestration receives parent.initialContext === parentContext.messages', async () => {
    let capturedParent: any = null
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, parent) => {
        capturedParent = parent
        return { runId: 'r', taskResults: [] }
      },
    )

    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'second' },
    ]
    const parentContext = { messages }

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await runOrchestrateDiscord(
      msg as any,
      JSON.parse(VALID_CONFIG) as any,
      { config: {} as any, provider: {} as any, registry: {} as any },
      undefined,
      undefined,
      parentContext,
    )

    expect(runOrchestrationSpy).toHaveBeenCalled()
    expect(capturedParent.initialContext).toBe(parentContext.messages)
    expect(capturedParent.initialContext).toHaveLength(2)
  })

  it('Phase 60 Test 4 — SubagentParent type accepts optional initialContext field (TypeScript compiles)', async () => {
    // This is a compile-time regression guard — if this test file typechecks,
    // SubagentParent.initialContext exists as an optional field. We verify
    // runtime by constructing a parent with initialContext and threading it.
    const subagentModule = await import('../agent/subagent.js')
    // SubagentParent is a type — we just confirm the field shape compiles below.
    expect(subagentModule).toBeDefined()

    let capturedParent: any = null
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, parent) => {
        capturedParent = parent
        return { runId: 'r', taskResults: [] }
      },
    )

    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await runOrchestrateDiscord(
      msg as any,
      JSON.parse(VALID_CONFIG) as any,
      { config: {} as any, provider: {} as any, registry: {} as any },
      undefined,
      undefined,
      { messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(capturedParent.initialContext).toBeDefined()
  })

  it('Phase 60 Test 5 — existing 5-arg callsites preserve behavior (undefined parentContext)', async () => {
    // Regression: handleOrchestrateCommand (JSON path) calls runOrchestrateDiscord
    // with 5 args; the 6th (parentContext) defaults to undefined. Confirms
    // existing !orchestrate behavior unchanged.
    let capturedParent: any = null
    runOrchestrationSpy = spyOn(engineModule, 'runOrchestration').mockImplementation(
      async (_config, parent) => {
        capturedParent = parent
        return { runId: 'r', taskResults: [] }
      },
    )

    const discordModule = await import('./discord.js')
    const msg = makeMsg(`!orchestrate ${VALID_CONFIG}`)
    await discordModule.handleOrchestrateCommand(msg, {
      config: {} as any,
      provider: {} as any,
      registry: {} as any,
    })

    // Wait for fire-and-forget
    await new Promise(r => setTimeout(r, 100))

    expect(capturedParent).not.toBeNull()
    // 5-arg callsite → parentContext undefined → initialContext undefined
    expect(capturedParent.initialContext).toBeUndefined()
  })
})
