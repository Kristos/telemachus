/**
 * Integration test: loop.ts audit hook
 *
 * Verifies that after a tool call, one JSONL line is written to the audit log
 * with the correct fields. Uses HOME override to redirect audit writes to a
 * temp directory — same pattern used in audit.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runAgentLoop, type LoopOptions } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
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

function makeTool(name: string): Tool {
  return {
    name,
    description: 'spy tool',
    inputSchema: z.any(),
    async execute(_args: unknown): Promise<ToolResult> {
      return { content: 'tool output', isError: false }
    },
  }
}

function toolCallTurn(name: string, id = 'tc1'): StreamResponse {
  const tc: ToolCallBlock = { id, name, input: { command: 'echo hi' } }
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

describe('loop audit integration', () => {
  let tmp: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kc-loop-audit-'))
    savedHome = process.env.HOME
    process.env.HOME = tmp
  })

  afterEach(() => {
    process.env.HOME = savedHome
    rmSync(tmp, { recursive: true, force: true })
  })

  test('tool call writes one JSONL audit entry with correct fields', async () => {
    const tool = makeTool('bash')
    const registry = new ToolRegistry()
    registry.registerAll([tool])

    const ctx: ToolContext = {
      cwd: process.cwd(),
      toolTimeoutMs: 5000,
      askUser: async () => '',
      sessionId: 'test-session-audit',
      mode: 'ask',
      sessionTmpdir: '/tmp/kc-test',
      sandboxAvailable: true,
    }

    const opts: LoopOptions = {
      provider: makeProvider([toolCallTurn('bash'), textTurn()]),
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

    await runAgentLoop([], opts)

    // Give the fire-and-forget append a tick to complete
    await new Promise(r => setTimeout(r, 50))

    // Find the JSONL file in the temp audit dir
    const auditDir = join(tmp, '.telemachus', 'audit')
    const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)

    const lines = readFileSync(join(auditDir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(1)

    const entry = JSON.parse(lines[0]!)
    expect(entry.tool).toBe('bash')
    expect(entry.tier).toBe('dangerous')
    expect(entry.sessionId).toBe('test-session-audit')
    expect(entry.mode).toBe('ask')
    expect(entry.platform).toBe(process.platform)
    expect(entry.argsHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(typeof entry.durationMs).toBe('number')
    expect(typeof entry.resultSize).toBe('number')
    expect(entry.exitCode).toBe(0)
    expect(['enforced', 'bypassed', 'unavailable', 'n/a']).toContain(entry.sandbox)
    // __sandboxStatus must not be on the audit entry (it's a protocol field, not logged)
    expect(entry.__sandboxStatus).toBeUndefined()
  })

  test('tool error sets exitCode 1 in audit entry', async () => {
    const errorTool: Tool = {
      name: 'bash',
      description: 'error tool',
      inputSchema: z.any(),
      async execute(): Promise<ToolResult> {
        return { content: 'command failed', isError: true }
      },
    }
    const registry = new ToolRegistry()
    registry.registerAll([errorTool])

    const ctx: ToolContext = {
      cwd: process.cwd(),
      toolTimeoutMs: 5000,
      askUser: async () => '',
      sessionId: 'test-session-error',
      mode: 'yolo',
    }

    const opts: LoopOptions = {
      provider: makeProvider([toolCallTurn('bash'), textTurn()]),
      tools: [errorTool],
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

    await runAgentLoop([], opts)
    await new Promise(r => setTimeout(r, 50))

    const auditDir = join(tmp, '.telemachus', 'audit')
    const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'))
    const lines = readFileSync(join(auditDir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)

    // Two entries are emitted (tool_call + tool_error) via fire-and-forget
    // appendAuditEntry calls; their order is non-deterministic. Pick the
    // tool_call entry explicitly rather than relying on positional access.
    const entries = lines.map(l => JSON.parse(l!))
    const entry = entries.find(e => e.kind === 'tool_call')
    expect(entry).toBeDefined()
    expect(entry!.exitCode).toBe(1)
    expect(entry!.mode).toBe('yolo')
  })
})
