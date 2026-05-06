/**
 * Integration test: loop.ts CLI tool routing (Phase 20, plan 03)
 *
 * Verifies the CLI-specific branch in the agent loop:
 *  - Metachar input short-circuits before permission gate (no prompt, no audit)
 *  - Permission callback receives the clean command summary, not the full arg string
 *  - Audit entry for CLI tools uses tool: 'cli:<name>' and resolved sub-command tier
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runAgentLoop, type LoopOptions } from './loop.js'
import { ToolRegistry } from '../tools/registry.js'
import { registerCliTools } from '../cli-tools/register.js'
import { clearCliTierOverrides } from '../security/trust-tiers.js'
import type { ToolContext } from '../tools/types.js'
import type {
  Provider,
  Message,
  StreamResponse,
  StreamOptions,
  APIToolSchema,
  ToolCallBlock,
} from '../providers/types.js'

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

function cliCallTurn(name: string, args: string, id = 'tc1'): StreamResponse {
  const tc: ToolCallBlock = { id, name, input: { args } }
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

describe('loop cli routing', () => {
  let tmp: string
  let savedHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kc-loop-cli-'))
    savedHome = process.env.HOME
    process.env.HOME = tmp
    clearCliTierOverrides()
  })

  afterEach(async () => {
    // Let any fire-and-forget audit flush
    await new Promise(r => setTimeout(r, 30))
    process.env.HOME = savedHome
    rmSync(tmp, { recursive: true, force: true })
    clearCliTierOverrides()
  })

  test('metachar input short-circuits before permission gate and audit', async () => {
    // Register an echo cli tool. We'll "invoke" with a metachar-laden arg.
    const tools = registerCliTools({
      cliTools: { echo: { command: 'echo', description: 'echo', trustTier: 'risky' } },
    } as any)
    const registry = new ToolRegistry()
    registry.registerAll(tools)

    let permissionCalls = 0
    const ctx: ToolContext = {
      cwd: process.cwd(),
      toolTimeoutMs: 5000,
      askUser: async () => '',
      sessionId: 'cli-metachar',
      mode: 'ask',
      sessionTmpdir: '/tmp/kc-test',
      sandboxAvailable: true,
      checkPermission: async () => {
        permissionCalls++
        return 'allow'
      },
    }

    const opts: LoopOptions = {
      provider: makeProvider([
        cliCallTurn('echo', 'hi; rm -rf /'),
        textTurn(),
      ]),
      tools,
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

    // Permission was never invoked — rejection short-circuited
    expect(permissionCalls).toBe(0)
    // Audit dir should NOT exist — nothing executed, nothing to log
    const auditDir = join(tmp, '.telemachus', 'audit')
    expect(existsSync(auditDir)).toBe(false)
  })

  test('permission callback receives clean command summary via __cliCommandSummary marker', async () => {
    const tools = registerCliTools({
      cliTools: { gh: { command: 'gh', description: 'gh', trustTier: 'risky' } },
    } as any)
    const registry = new ToolRegistry()
    registry.registerAll(tools)

    let seenInput: unknown = null
    const ctx: ToolContext = {
      cwd: process.cwd(),
      toolTimeoutMs: 5000,
      askUser: async () => '',
      sessionId: 'cli-summary',
      mode: 'ask',
      sessionTmpdir: '/tmp/kc-test',
      sandboxAvailable: true,
      checkPermission: async (_name, input) => {
        seenInput = input
        return 'deny' // short-circuit: we only care about the prompt input
      },
    }

    const opts: LoopOptions = {
      provider: makeProvider([
        cliCallTurn('gh', 'pr list --state open --limit 50'),
        textTurn(),
      ]),
      tools,
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

    const input = seenInput as Record<string, unknown>
    expect(input).not.toBeNull()
    expect(input.__cliCommandSummary).toBe('gh pr list')
    // The original args field is preserved for the tool executor
    expect(input.args).toBe('pr list --state open --limit 50')
  })

  test('audit entry uses cli:<name> prefix and resolved sub-command tier', async () => {
    const tools = registerCliTools({
      cliTools: {
        gh: {
          command: 'echo', // use echo to avoid needing real gh; cli tool name stays 'gh'
          description: 'gh',
          trustTier: 'risky',
          subCommandTiers: { 'pr merge': 'dangerous' },
        },
      },
    } as any)
    const registry = new ToolRegistry()
    registry.registerAll(tools)

    const ctx: ToolContext = {
      cwd: process.cwd(),
      toolTimeoutMs: 5000,
      askUser: async () => '',
      sessionId: 'cli-audit',
      mode: 'yolo', // bypass sandbox + permission so we actually spawn
      sessionTmpdir: '/tmp/kc-test',
      sandboxAvailable: true,
    }

    const opts: LoopOptions = {
      provider: makeProvider([
        cliCallTurn('gh', 'pr merge 123'),
        textTurn(),
      ]),
      tools,
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
    // Allow fire-and-forget audit to flush
    await new Promise(r => setTimeout(r, 100))

    const auditDir = join(tmp, '.telemachus', 'audit')
    expect(existsSync(auditDir)).toBe(true)
    const files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
    const lines = readFileSync(join(auditDir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.tool).toBe('cli:gh')
    expect(entry.tier).toBe('dangerous') // sub-command override wins
    expect(entry.argsHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
