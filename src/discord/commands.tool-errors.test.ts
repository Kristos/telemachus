/**
 * Phase 63 (OBS-05): Tests for !tool-errors Discord command.
 *
 * Uses spyOn only — no mock.module per CLAUDE.md.
 * Stubs DiscordMessage with minimal bun:test mock() for reply/sendTyping.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { isCommand, handleCommand } from './commands.js'
import {
  recordError,
  __resetForTests as resetMetrics,
} from '../security/tool-error-metrics.js'
import type { AuditEntry } from '../security/audit.js'
import type { DiscordMessage } from './runner.js'
import type { CommandDeps } from './commands.js'

function mkErr(tool: string, tsMs: number, errorClass = 'EROFS'): AuditEntry {
  return {
    kind: 'tool_error',
    sessionId: 's',
    platform: 'darwin',
    tool,
    errorClass,
    errorMessage: `${errorClass} sample`,
    ts: new Date(tsMs).toISOString(),
  }
}

function makeMsg(content: string): {
  msg: DiscordMessage
  replySpy: ReturnType<typeof mock>
} {
  const replySpy = mock((_text: string) => Promise.resolve())
  const msg: DiscordMessage = {
    channelId: 'ch-001',
    content,
    authorId: 'user-123',
    reply: replySpy as (text: string) => Promise<void>,
    sendTyping: mock(() => Promise.resolve()) as () => Promise<void>,
    isGuild: false,
  }
  return { msg, replySpy }
}

function makeDeps(): CommandDeps {
  return {
    config: {
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
    } as CommandDeps['config'],
    provider: {} as never,
    registry: {} as never,
    onJobComplete: async () => {},
  }
}

describe('!tool-errors — isCommand', () => {
  test('1: "!tool-errors" → true', () => {
    expect(isCommand('!tool-errors')).toBe(true)
  })

  test('2: "!tool-errors 1h" → true', () => {
    expect(isCommand('!tool-errors 1h')).toBe(true)
  })

  test('3: "!tool-error" (typo) → false', () => {
    expect(isCommand('!tool-error')).toBe(false)
  })

  test('4: "!tool-errors 24h" → true', () => {
    expect(isCommand('!tool-errors 24h')).toBe(true)
  })
})

describe('!tool-errors — handleCommand', () => {
  beforeEach(() => {
    resetMetrics()
  })

  test('5: empty metric → reply "No tool errors in the last 15m."', async () => {
    const { msg, replySpy } = makeMsg('!tool-errors')
    await handleCommand(msg, makeDeps())
    expect(replySpy).toHaveBeenCalledTimes(1)
    const text = replySpy.mock.calls[0]![0] as string
    expect(text).toContain('No tool errors')
    expect(text).toContain('15m')
  })

  test('6: !tool-errors 1h with 3 tools → reply lists them with counts + last class', async () => {
    const now = Date.now()
    const nowFn = () => now
    for (let i = 0; i < 5; i++) {
      recordError(mkErr('write_file', now - 60_000 - i * 100, 'EROFS'), nowFn)
    }
    for (let i = 0; i < 3; i++) {
      recordError(mkErr('glob', now - 120_000 - i * 100, 'EBADF'), nowFn)
    }
    for (let i = 0; i < 2; i++) {
      recordError(mkErr('write_todos', now - 180_000 - i * 100, 'EROFS'), nowFn)
    }
    const { msg, replySpy } = makeMsg('!tool-errors 1h')
    await handleCommand(msg, makeDeps())
    const text = replySpy.mock.calls[0]![0] as string
    expect(text).toContain('1h')
    expect(text).toContain('write_file: 5 failures (EROFS)')
    expect(text).toContain('glob: 3 failures (EBADF)')
    expect(text).toContain('write_todos: 2 failures')
  })

  test('7: !tool-errors 5d (unsupported window) → reply falls back to 15m + supported-list hint', async () => {
    const { msg, replySpy } = makeMsg('!tool-errors 5d')
    await handleCommand(msg, makeDeps())
    const text = replySpy.mock.calls[0]![0] as string
    // Supported-window hint AND 15m default shown
    expect(text.toLowerCase()).toContain('supported')
    expect(text).toContain('15m')
  })

  test('8: !tool-errors (default 15m) with errors in last 15m → lists them', async () => {
    const now = Date.now()
    const nowFn = () => now
    for (let i = 0; i < 4; i++) {
      recordError(mkErr('bash', now - 1000 - i * 100, 'Error'), nowFn)
    }
    const { msg, replySpy } = makeMsg('!tool-errors')
    await handleCommand(msg, makeDeps())
    const text = replySpy.mock.calls[0]![0] as string
    expect(text).toContain('bash: 4 failures')
    expect(text).toContain('15m')
  })

  test('9: !tool-errors on errors older than window → empty reply', async () => {
    const now = Date.now()
    const nowFn = () => now
    // Put errors 30m ago — outside default 15m window
    for (let i = 0; i < 5; i++) {
      recordError(mkErr('bash', now - 30 * 60_000 - i * 100, 'EROFS'), nowFn)
    }
    const { msg, replySpy } = makeMsg('!tool-errors')
    await handleCommand(msg, makeDeps())
    const text = replySpy.mock.calls[0]![0] as string
    expect(text).toContain('No tool errors')
  })
})

describe('!help — lists !tool-errors', () => {
  test('10: !help output includes !tool-errors line', async () => {
    const { msg, replySpy } = makeMsg('!help')
    await handleCommand(msg, makeDeps())
    const text = replySpy.mock.calls[0]![0] as string
    expect(text).toContain('!tool-errors')
  })
})
