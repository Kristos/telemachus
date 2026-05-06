/**
 * Phase 63 (OBS-01): tool_error emission from the agent loop.
 *
 * These tests use spyOn(auditModule, 'appendAuditEntry') rather than HOME-
 * redirected file writes so we can assert the emitted rows directly without
 * racing the fire-and-forget append. That pattern mirrors
 * src/tools/builtin/git-deploy.test.ts.
 *
 * NO mock.module() — CLAUDE.md forbids it.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { runAgentLoop, type LoopOptions } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import * as auditModule from '../security/audit.js'
import type { Tool, ToolContext, ToolResult } from '../tools/types.js'
import type {
  Provider,
  Message,
  StreamResponse,
  StreamOptions,
  APIToolSchema,
  ToolCallBlock,
} from '../providers/types.js'
import { z } from 'zod'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeProvider(scripted: StreamResponse[]): Provider {
  let i = 0
  return {
    name: 'stub',
    async stream(_msgs: Message[], _tools: APIToolSchema[], opts: StreamOptions) {
      const r = scripted[i++] ?? {
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end',
      }
      if (r.text) opts.onTextChunk(r.text)
      return r
    },
  }
}

function toolCallTurn(name: string, id = 'tc1'): StreamResponse {
  const tc: ToolCallBlock = { id, name, input: {} }
  return {
    text: '',
    toolCalls: [tc],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: 'tool_use',
  }
}

function textTurn(text = 'done'): StreamResponse {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    stopReason: 'end',
  }
}

function makeOptions(provider: Provider, tool: Tool, ctxOverrides?: Partial<ToolContext>): LoopOptions {
  const registry = new ToolRegistry()
  registry.registerAll([tool])
  const ctx: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 5000,
    askUser: async () => '',
    sessionId: 'obs01-test',
    mode: 'yolo',
    ...ctxOverrides,
  }
  return {
    provider,
    tools: [tool],
    registry,
    apiSchemas: [],
    maxIterations: 5,
    temperature: 0,
    windowSize: 100,
    toolContext: ctx,
    callbacks: {
      onTextChunk: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onTurnComplete: () => {},
    },
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('OBS-01: tool_error emission', () => {
  let auditCalls: auditModule.AuditEntry[]
  let auditSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    auditCalls = []
    auditSpy = spyOn(auditModule, 'appendAuditEntry').mockImplementation(
      async (entry: auditModule.AuditEntry) => {
        auditCalls.push(entry)
      },
    )
  })

  afterEach(() => {
    auditSpy.mockRestore()
  })

  test('1: tool throws Node-style EROFS → one tool_error row + one tool_call row', async () => {
    const tool: Tool = {
      name: 'write_file',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      },
    }
    const provider = makeProvider([toolCallTurn('write_file'), textTurn()])
    await runAgentLoop([], makeOptions(provider, tool))

    const toolCallRows = auditCalls.filter((e) => e.kind === 'tool_call')
    const toolErrorRows = auditCalls.filter((e) => e.kind === 'tool_error')

    expect(toolCallRows.length).toBe(1)
    expect(toolCallRows[0]!.exitCode).toBe(1)
    expect(toolErrorRows.length).toBe(1)
    expect(toolErrorRows[0]!.tool).toBe('write_file')
    expect(toolErrorRows[0]!.errorClass).toBe('EROFS')
    expect(toolErrorRows[0]!.sessionId).toBe('obs01-test')
  })

  test('2: tool returns {isError:true} without throwing → one tool_error row', async () => {
    const tool: Tool = {
      name: 'glob',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        return { content: 'glob failed: EBADF bad file descriptor', isError: true }
      },
    }
    const provider = makeProvider([toolCallTurn('glob'), textTurn()])
    await runAgentLoop([], makeOptions(provider, tool))

    const toolErrorRows = auditCalls.filter((e) => e.kind === 'tool_error')
    expect(toolErrorRows.length).toBe(1)
    expect(toolErrorRows[0]!.tool).toBe('glob')
    // When the tool reported the error internally, errorClass is 'ToolReportedError'
    // and errorMessage carries the tool's content verbatim (truncated to 500).
    expect(toolErrorRows[0]!.errorClass).toBe('ToolReportedError')
    expect(toolErrorRows[0]!.errorMessage).toContain('EBADF')
  })

  test('3: tool succeeds → no tool_error row', async () => {
    const tool: Tool = {
      name: 'echo',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        return { content: 'hello', isError: false }
      },
    }
    const provider = makeProvider([toolCallTurn('echo'), textTurn()])
    await runAgentLoop([], makeOptions(provider, tool))

    const toolErrorRows = auditCalls.filter((e) => e.kind === 'tool_error')
    expect(toolErrorRows.length).toBe(0)
    const toolCallRows = auditCalls.filter((e) => e.kind === 'tool_call')
    expect(toolCallRows.length).toBe(1)
    expect(toolCallRows[0]!.exitCode).toBe(0)
  })

  test('4: Discord-source context → tool_error row carries source/discordChannelId/discordUserId', async () => {
    const tool: Tool = {
      name: 'write_todos',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        throw Object.assign(new Error('read-only'), { code: 'EROFS' })
      },
    }
    const provider = makeProvider([toolCallTurn('write_todos'), textTurn()])
    await runAgentLoop(
      [],
      makeOptions(provider, tool, {
        source: 'discord',
        discordChannelId: 'chan-123',
        discordUserId: 'user-456',
      }),
    )

    const toolErrorRows = auditCalls.filter((e) => e.kind === 'tool_error')
    expect(toolErrorRows.length).toBe(1)
    expect(toolErrorRows[0]!.source).toBe('discord')
    expect(toolErrorRows[0]!.discordChannelId).toBe('chan-123')
    expect(toolErrorRows[0]!.discordUserId).toBe('user-456')
    expect(toolErrorRows[0]!.channelId).toBe('chan-123')
  })

  test('5: LoopOptions.turnId populated → tool_error.turnId matches', async () => {
    const tool: Tool = {
      name: 'bash',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        throw new Error('boom')
      },
    }
    const provider = makeProvider([toolCallTurn('bash'), textTurn()])
    const opts = makeOptions(provider, tool)
    opts.turnId = 'turn-uuid-abc'
    await runAgentLoop([], opts)

    const toolErrorRows = auditCalls.filter((e) => e.kind === 'tool_error')
    expect(toolErrorRows.length).toBe(1)
    expect(toolErrorRows[0]!.turnId).toBe('turn-uuid-abc')
  })

  test('6: appendAuditEntry throws → loop continues without unhandled rejection', async () => {
    auditSpy.mockImplementation(async () => {
      throw new Error('disk full')
    })
    const tool: Tool = {
      name: 'bash',
      description: 'spy',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        throw new Error('boom')
      },
    }
    const provider = makeProvider([toolCallTurn('bash'), textTurn()])
    // Must not throw.
    await runAgentLoop([], makeOptions(provider, tool))
    // Sanity: the loop ran to completion despite audit failures.
    expect(true).toBe(true)
  })
})
