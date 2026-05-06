/**
 * Phase 33-01 (JOB-01, JOB-02, JOB-03): Tests for Discord command dispatcher.
 *
 * Tests validate:
 *   - isCommand correctly identifies !run and !status prefixes
 *   - !run dispatches background job and replies with confirmation
 *   - !run with unknown job replies with error + available jobs list
 *   - !run with no job name replies with usage hint
 *   - !status with job name replies with formatted run history
 *   - !status with no name replies with all-jobs summary
 *   - !status with unknown job replies with "no runs found"
 *   - onJobComplete callback invoked when background job resolves
 *   - onJobComplete callback invoked with error info when job fails
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import type { RunJobResult } from '../agent-runner/run-job.js'
import type { StatusRow } from '../agent-runner/status.js'

// ── runJob mock ───────────────────────────────────────────────────────────────

let runJobResolve: (result: RunJobResult) => void
let runJobReject: (err: Error) => void
let runJobShouldFail = false
const runJobCalls: Array<{ jobName: string }> = []

const stubResult: RunJobResult = {
  exitReason: 'natural',
  turnCount: 3,
  durationMs: 12000,
  error: null,
  runDir: '/home/test/.telemachus/agent-runs/nightly-job/2026-04-12T10-00-00Z',
  runDirName: '2026-04-12T10-00-00Z',
  parentDir: '/home/test/.telemachus/agent-runs/nightly-job',
  logPath: '/home/test/.telemachus/agent-runs/nightly-job/2026-04-12T10-00-00Z/log.txt',
  resultPath: '/home/test/.telemachus/agent-runs/nightly-job/2026-04-12T10-00-00Z/result.md',
  usagePath: '/home/test/.telemachus/agent-runs/nightly-job/2026-04-12T10-00-00Z/usage.json',
  configPath: '/home/test/.telemachus/agent-runs/nightly-job/2026-04-12T10-00-00Z/config.json',
}

mock.module('../agent-runner/run-job.js', () => ({
  runJob: async (jobName: string, _jobCfg: unknown, _ctx: unknown) => {
    runJobCalls.push({ jobName })
    if (runJobShouldFail) {
      throw new Error('job failed hard')
    }
    return stubResult
  },
}))

// ── loadStatusRows mock ───────────────────────────────────────────────────────

let statusRowsToReturn: StatusRow[] = []

mock.module('../agent-runner/status.js', () => ({
  loadStatusRows: async (_opts: unknown) => {
    return statusRowsToReturn
  },
  formatDuration: (ms: number | null) => (ms === null ? '?' : `${Math.floor(ms / 1000)}s`),
  formatStarted: (iso: string) => iso.replace('T', ' ').replace('Z', ''),
}))

// ── Import AFTER mocks ────────────────────────────────────────────────────────

const { isCommand, handleCommand } = await import('./commands.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig() {
  return {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo' as const,
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {},
    agents: {
      'nightly-job': {
        prompt: 'Scrape auction listings and report findings',
      },
      'daily-report': {
        prompt: 'Generate daily report',
      },
    },
  }
}

function makeMsg(content: string, channelId = 'ch-001') {
  const replySpy = mock((_text: string) => Promise.resolve())
  const msg = {
    channelId,
    content,
    authorId: 'user-123',
    reply: replySpy,
    sendTyping: mock(() => Promise.resolve()),
    isGuild: false,
  }
  return { msg, replySpy }
}

function makeDeps(overrides: Partial<{
  onJobComplete: (channelId: string, jobName: string, result: RunJobResult) => Promise<void>
}> = {}) {
  const onJobComplete = overrides.onJobComplete ?? mock(async () => {})
  return {
    config: makeConfig(),
    provider: {} as never,
    registry: {} as never,
    onJobComplete,
  }
}

// ── Test reset ────────────────────────────────────────────────────────────────

beforeEach(() => {
  runJobCalls.length = 0
  runJobShouldFail = false
  statusRowsToReturn = []
})

afterEach(() => {
  runJobCalls.length = 0
})

// ── isCommand tests ───────────────────────────────────────────────────────────

describe('isCommand', () => {
  test('returns true for !run <job>', () => {
    expect(isCommand('!run nightly-job')).toBe(true)
  })

  test('returns true for !status <job>', () => {
    expect(isCommand('!status nightly-job')).toBe(true)
  })

  test('returns true for bare !status (no args)', () => {
    expect(isCommand('!status')).toBe(true)
  })

  test('returns false for normal message', () => {
    expect(isCommand('hello bot')).toBe(false)
  })

  test('returns false for !unknown command', () => {
    expect(isCommand('!unknown foo')).toBe(false)
  })

  test('returns true for bare !index', () => {
    expect(isCommand('!index')).toBe(true)
  })

  test('returns true for !index scan', () => {
    expect(isCommand('!index scan')).toBe(true)
  })

  test('returns true for !index status', () => {
    expect(isCommand('!index status')).toBe(true)
  })

  test('returns false for !run with no space (bare !run)', () => {
    // "!run" alone is ambiguous — we require a job name for !run
    expect(isCommand('!run')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isCommand('')).toBe(false)
  })
})

// ── !run tests ────────────────────────────────────────────────────────────────

describe('handleCommand: !run', () => {
  test('replies with confirmation and runs job in background when job exists', async () => {
    const onJobComplete = mock(async () => {})
    const deps = makeDeps({ onJobComplete })
    const { msg, replySpy } = makeMsg('!run nightly-job')

    await handleCommand(msg, deps)

    // Immediate confirmation reply
    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText).toContain('nightly-job')

    // Job runs in background — wait for background promise
    await new Promise((r) => setTimeout(r, 20))
    expect(runJobCalls).toHaveLength(1)
    expect(runJobCalls[0].jobName).toBe('nightly-job')
  })

  test('calls onJobComplete with result when job succeeds', async () => {
    const completeCalls: Array<{ channelId: string; jobName: string; result: RunJobResult }> = []
    const deps = makeDeps({
      onJobComplete: async (channelId, jobName, result) => {
        completeCalls.push({ channelId, jobName, result })
      },
    })
    const { msg } = makeMsg('!run nightly-job', 'ch-test')

    await handleCommand(msg, deps)
    await new Promise((r) => setTimeout(r, 20))

    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].channelId).toBe('ch-test')
    expect(completeCalls[0].jobName).toBe('nightly-job')
    expect(completeCalls[0].result.exitReason).toBe('natural')
    expect(completeCalls[0].result.error).toBeNull()
  })

  test('calls onJobComplete with error result when job throws', async () => {
    runJobShouldFail = true
    const completeCalls: Array<{ channelId: string; jobName: string; result: RunJobResult }> = []
    const deps = makeDeps({
      onJobComplete: async (channelId, jobName, result) => {
        completeCalls.push({ channelId, jobName, result })
      },
    })
    const { msg } = makeMsg('!run nightly-job', 'ch-err')

    await handleCommand(msg, deps)
    await new Promise((r) => setTimeout(r, 20))

    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0].result.error).not.toBeNull()
    expect(completeCalls[0].result.error?.message).toContain('job failed')
  })

  test('replies with error and available jobs when job does not exist', async () => {
    const { msg, replySpy } = makeMsg('!run nonexistent-job')
    await handleCommand(msg, makeDeps())

    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText.toLowerCase()).toContain('unknown')
    // Should list available jobs
    expect(replyText).toContain('nightly-job')
    expect(replyText).toContain('daily-report')
  })

  test('replies with usage hint when no job name given', async () => {
    // !run with space then nothing, or just "!run "
    const { msg, replySpy } = makeMsg('!run ')
    await handleCommand(msg, makeDeps())

    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText.toLowerCase()).toMatch(/usage|job name/)
  })
})

// ── !status tests ─────────────────────────────────────────────────────────────

describe('handleCommand: !status', () => {
  test('replies with formatted status for known job', async () => {
    statusRowsToReturn = [
      {
        job: 'nightly-job',
        startedAt: '2026-04-12T10:00:00Z',
        durationMs: 12000,
        tokens: null,
        exitReason: 'natural',
        webhook: null,
      },
    ]
    const { msg, replySpy } = makeMsg('!status nightly-job')
    await handleCommand(msg, makeDeps())

    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText).toContain('nightly-job')
    expect(replyText).toContain('natural')
  })

  test('replies with all-jobs summary when no job name given', async () => {
    statusRowsToReturn = [
      {
        job: 'nightly-job',
        startedAt: '2026-04-12T10:00:00Z',
        durationMs: 5000,
        tokens: null,
        exitReason: 'natural',
        webhook: null,
      },
      {
        job: 'daily-report',
        startedAt: '2026-04-11T09:00:00Z',
        durationMs: 30000,
        tokens: null,
        exitReason: 'max_iter',
        webhook: null,
      },
    ]
    const { msg, replySpy } = makeMsg('!status')
    await handleCommand(msg, makeDeps())

    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText).toContain('nightly-job')
    expect(replyText).toContain('daily-report')
  })

  test('replies with no runs found message when job has no history', async () => {
    statusRowsToReturn = []
    const { msg, replySpy } = makeMsg('!status nonexistent')
    await handleCommand(msg, makeDeps())

    expect(replySpy).toHaveBeenCalledTimes(1)
    const replyText = (replySpy.mock.calls[0] as [string])[0]
    expect(replyText.toLowerCase()).toContain('no runs')
  })
})
