/**
 * Phase 33-02 (JOB-01, JOB-02, JOB-03): Integration tests for command dispatch
 * through the runner adapter.
 *
 * Tests validate end-to-end behaviour of handleDiscordMessage:
 *   - !run messages skip the agent loop (runSubagent NOT called)
 *   - !status messages skip the agent loop (runSubagent NOT called)
 *   - Normal messages reach the agent loop (runSubagent IS called)
 *   - Unknown job names produce an error reply with available job list
 *   - onJobComplete callback fires after the background !run job resolves
 *
 * runSubagent and runJob are both mocked so the tests don't touch the
 * real agent loop or file system.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { resetQueueForTest } from '../turn-queue.js'
import { clearAllPendingDispatches } from '../auto-dispatch-state.js'
import type { SubagentParent, SubagentOverrides } from '../../agent/subagent.js'
import type { RunJobResult } from '../../agent-runner/run-job.js'
import type { StatusRow } from '../../agent-runner/status.js'
import { ConversationManager } from '../conversation.js'
import type { KristosConfig } from '../../config/types.js'
import type { Provider } from '../../providers/types.js'
import type { ToolRegistry } from '../../tools/registry.js'

// ── runSubagent stub ──────────────────────────────────────────────────────────
//
// Tracks calls so tests can assert runSubagent was (or was not) invoked.

const runSubagentCalls: Array<{ parent: SubagentParent; prompt: string; overrides: SubagentOverrides }> = []
let runSubagentResponse = 'agent reply'

mock.module('../../agent/subagent.js', () => ({
  runSubagent: async (
    parent: SubagentParent,
    prompt: string,
    overrides: SubagentOverrides = {},
  ) => {
    runSubagentCalls.push({ parent, prompt, overrides })
    return { text: runSubagentResponse, messages: [], error: null }
  },
}))

// ── session-bridge stub ───────────────────────────────────────────────────────

mock.module('../session-bridge.js', () => ({
  ensureSession: async (_channelId: string, _mapping: Record<string, string>, _model: string) =>
    `discord-${_channelId}`,
  persistTurnDelta: async () => {},
  loadMapping: async () => ({}),
  hydrateConversations: async () => {},
  saveMapping: async () => {},
}))

// ── runJob stub ───────────────────────────────────────────────────────────────

const stubRunJobResult: RunJobResult = {
  exitReason: 'natural',
  turnCount: 3,
  durationMs: 12000,
  error: null,
  runDir: '/home/test/.telemachus/agent-runs/test-job/2026-04-12T10-00-00Z',
  runDirName: '2026-04-12T10-00-00Z',
  parentDir: '/home/test/.telemachus/agent-runs/test-job',
  logPath: '/home/test/.telemachus/agent-runs/test-job/2026-04-12T10-00-00Z/log.txt',
  resultPath: '/home/test/.telemachus/agent-runs/test-job/2026-04-12T10-00-00Z/result.md',
  usagePath: '/home/test/.telemachus/agent-runs/test-job/2026-04-12T10-00-00Z/usage.json',
  configPath: '/home/test/.telemachus/agent-runs/test-job/2026-04-12T10-00-00Z/config.json',
}

let runJobShouldFail = false
const runJobCalls: Array<{ jobName: string }> = []

mock.module('../../agent-runner/run-job.js', () => ({
  runJob: async (jobName: string, _jobCfg: unknown, _ctx: unknown) => {
    runJobCalls.push({ jobName })
    if (runJobShouldFail) throw new Error('runJob failed')
    // Small delay to ensure confirmation reply fires before completion reply
    await new Promise((r) => setTimeout(r, 10))
    return stubRunJobResult
  },
}))

// ── loadStatusRows stub ───────────────────────────────────────────────────────

const stubStatusRows: StatusRow[] = [
  {
    job: 'test-job',
    startedAt: '2026-04-12T10:00:00Z',
    durationMs: 12000,
    tokens: null,
    exitReason: 'natural',
    webhook: null,
  },
]

mock.module('../../agent-runner/status.js', () => ({
  loadStatusRows: async (_opts: unknown) => stubStatusRows,
  formatDuration: (ms: number | null) => (ms === null ? '?' : `${Math.floor(ms / 1000)}s`),
  formatStarted: (iso: string) => iso.replace('T', ' ').replace('Z', ''),
}))

// ── Import runner AFTER all mocks ─────────────────────────────────────────────

const { handleDiscordMessage } = await import('../runner.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(extraAgents: Record<string, { prompt: string }> = {}): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {},
    agents: {
      'test-job': { prompt: 'Run the test job' },
      'other-job': { prompt: 'Run the other job' },
      ...extraAgents,
    },
  }
}

const stubProvider: Provider = {
  name: 'stub',
  stream: async (_messages, _schemas, opts) => {
    opts?.onTextChunk?.(runSubagentResponse)
    return {
      text: runSubagentResponse,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }
  },
}

const stubRegistry = {
  toAPISchema: () => [],
  getAll: () => [],
} as unknown as ToolRegistry

function makeDeps(config?: KristosConfig) {
  return {
    config: config ?? makeConfig(),
    provider: stubProvider,
    registry: stubRegistry,
    conversations: new ConversationManager(),
    // Phase 64 (PERS-01): systemPrompt is now a per-channel builder function
    systemPrompt: (_channelId: string) => 'You are a helpful assistant.',
    sessionMapping: {} as Record<string, string>,
    model: 'test-model',
  }
}

function makeMsg(content: string, channelId = 'ch-001') {
  const replyCalls: string[] = []
  const replySpy = mock((text: string) => {
    replyCalls.push(text)
    return Promise.resolve()
  })
  const typingSpy = mock(() => Promise.resolve())
  const msg = {
    channelId,
    content,
    authorId: 'user-123',
    reply: replySpy,
    sendTyping: typingSpy,
    isGuild: false,
  }
  return { msg, replySpy, replyCalls, typingSpy }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  runSubagentCalls.length = 0
  runJobCalls.length = 0
  runJobShouldFail = false
  runSubagentResponse = 'agent reply'
  // Module-level state from prior test files in the same bun worker can
  // leak (channelQueues, pending dispatch timers) and short-circuit
  // handleDiscordMessage before runSubagent is reached.
  resetQueueForTest()
  clearAllPendingDispatches()
})

afterEach(() => {
  runSubagentCalls.length = 0
  runJobCalls.length = 0
})

// ── Integration tests ─────────────────────────────────────────────────────────

describe('handleDiscordMessage: !run skips agent loop', () => {
  it('does not call runSubagent for !run <known-job>', async () => {
    const { msg, replySpy } = makeMsg('!run test-job')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)

    // Command should have replied immediately (confirmation)
    expect(replySpy).toHaveBeenCalled()
    const firstReply = (replySpy.mock.calls[0] as [string])[0]
    expect(firstReply).toContain('test-job')
    expect(firstReply.toLowerCase()).toMatch(/starting|start/)

    // runSubagent must NOT be called — command was intercepted
    expect(runSubagentCalls).toHaveLength(0)
  })
})

describe('handleDiscordMessage: !status skips agent loop', () => {
  it('does not call runSubagent for !status <job>', async () => {
    const { msg, replySpy } = makeMsg('!status test-job')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)

    // Should reply with status info
    expect(replySpy).toHaveBeenCalled()
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText).toContain('test-job')

    // runSubagent must NOT be called
    expect(runSubagentCalls).toHaveLength(0)
  })

  it('does not call runSubagent for bare !status', async () => {
    const { msg, replySpy } = makeMsg('!status')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)

    expect(replySpy).toHaveBeenCalled()
    expect(runSubagentCalls).toHaveLength(0)
  })
})

describe('handleDiscordMessage: normal messages reach agent loop', () => {
  it('calls runSubagent for a plain text message', async () => {
    const { msg, replySpy } = makeMsg('hello there')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)
    // Allow promise queue to flush
    await new Promise((r) => setTimeout(r, 20))

    // Agent loop should have been invoked
    expect(runSubagentCalls).toHaveLength(1)
    expect(runSubagentCalls[0].prompt).toBe('hello there')

    // Agent reply should be sent
    expect(replySpy).toHaveBeenCalledWith('agent reply')
  })
})

describe('handleDiscordMessage: !run unknown job shows error', () => {
  it('replies with error message listing available jobs', async () => {
    const { msg, replySpy } = makeMsg('!run nosuchjob')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)

    expect(replySpy).toHaveBeenCalled()
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    // Should mention the unknown job
    expect(replyText).toContain('nosuchjob')
    // Should list available jobs
    expect(replyText).toContain('test-job')
    expect(replyText).toContain('other-job')

    // runSubagent must NOT be called
    expect(runSubagentCalls).toHaveLength(0)
  })
})

describe('handleDiscordMessage: !run completion callback posts result', () => {
  it('sends confirmation immediately, then posts completion result after job finishes', async () => {
    const { msg, replySpy, replyCalls } = makeMsg('!run test-job', 'ch-callback')
    const handler = handleDiscordMessage(makeDeps())

    await handler(msg)

    // At this point: confirmation reply should have fired (command returns fast)
    // Background job is still running (10ms delay in mock)
    expect(replySpy).toHaveBeenCalledTimes(1)
    expect(replyCalls[0]).toContain('test-job')

    // Wait for background job to complete
    await new Promise((r) => setTimeout(r, 50))

    // Now completion summary should have been posted
    expect(replySpy).toHaveBeenCalledTimes(2)
    const completionReply = replyCalls[1]
    expect(completionReply).toContain('test-job')
    // Result summary should contain exit reason or duration
    expect(completionReply.toLowerCase()).toMatch(/complete|natural|duration/)

    // runJob was called (background job ran)
    expect(runJobCalls).toHaveLength(1)
    expect(runJobCalls[0].jobName).toBe('test-job')

    // runSubagent was NOT called (command path, not agent loop)
    expect(runSubagentCalls).toHaveLength(0)
  })
})
