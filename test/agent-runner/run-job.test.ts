import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runJob, type RunJobMcpManager } from '../../src/agent-runner/run-job.js'
import { DEFAULT_CONFIG, type KristosConfig } from '../../src/config/types.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { createStubProvider } from '../fixtures/stub-provider.js'

function kc(): KristosConfig {
  return { ...DEFAULT_CONFIG }
}

let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-agent-'))
})

afterEach(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

describe('runJob — happy path (Phase 22-02)', () => {
  test('writes all 4 artifacts, updates latest, exits natural', async () => {
    const provider = createStubProvider({
      responses: [{ text: 'hello from stub', toolCalls: [] }],
    })
    const registry = new ToolRegistry()

    const result = await runJob(
      'happy',
      { prompt: 'hi there', maxIterations: 5 },
      {
        home: tmpHome,
        kcConfig: kc(),
        provider,
        registry,
        now: () => new Date('2026-04-08T14:30:00.000Z'),
      },
    )

    expect(result.exitReason).toBe('natural')
    expect(result.error).toBeNull()
    expect(provider.callCount).toBe(1)

    // All 4 artifacts exist
    const runDir = path.join(
      tmpHome,
      '.telemachus',
      'agent-runs',
      'happy',
      '2026-04-08T14-30-00Z',
    )
    expect(fs.existsSync(path.join(runDir, 'log.txt'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'result.md'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'usage.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'config.json'))).toBe(true)

    // result.md has the model text
    const resultText = await fsp.readFile(path.join(runDir, 'result.md'), 'utf8')
    expect(resultText).toBe('hello from stub')

    // usage.json reflects natural exit
    const usage = JSON.parse(
      await fsp.readFile(path.join(runDir, 'usage.json'), 'utf8'),
    )
    expect(usage.exit_reason).toBe('natural')
    expect(usage.error).toBeNull()
    expect(usage.turn_count).toBe(1)
    expect(typeof usage.duration_ms).toBe('number')

    // config.json round-trips the job config
    const cfg = JSON.parse(
      await fsp.readFile(path.join(runDir, 'config.json'), 'utf8'),
    )
    expect(cfg.prompt).toBe('hi there')
    expect(cfg.maxIterations).toBe(5)

    // latest symlink points at the run dir name
    const latest = await fsp.readlink(
      path.join(tmpHome, '.telemachus', 'agent-runs', 'happy', 'latest'),
    )
    expect(latest).toBe('2026-04-08T14-30-00Z')
  })
})

describe('runJob — iteration cap fires', () => {
  test('stub loops tool_calls, maxIterations:3 → exit_reason=max_iterations', async () => {
    // Every stream() response includes a fake tool call so the loop
    // never naturally terminates. The iteration cap must kick in.
    const fakeToolCall = {
      id: 'tc-1',
      name: 'nonexistent_tool',
      input: {},
    }
    const responses = Array.from({ length: 20 }, () => ({
      text: '',
      toolCalls: [fakeToolCall],
    }))
    const provider = createStubProvider({ responses })
    const registry = new ToolRegistry()

    const result = await runJob(
      'loopy',
      { prompt: 'loop forever', maxIterations: 3 },
      {
        home: tmpHome,
        kcConfig: kc(),
        provider,
        registry,
        now: () => new Date('2026-04-08T15:00:00.000Z'),
      },
    )

    expect(result.exitReason).toBe('max_iterations')
    const usage = JSON.parse(
      await fsp.readFile(
        path.join(
          tmpHome,
          '.telemachus',
          'agent-runs',
          'loopy',
          '2026-04-08T15-00-00Z',
          'usage.json',
        ),
        'utf8',
      ),
    )
    expect(usage.exit_reason).toBe('max_iterations')
    // Stub was called exactly maxIterations times before the cap fired at
    // the head of turn 4.
    expect(provider.callCount).toBe(3)
  })
})

describe('runJob — MCP lifecycle (zero tool calls)', () => {
  test('loadEager + dispose both fire even with zero MCP calls', async () => {
    // Stub McpManager that records lifecycle calls.
    let loadEagerCalls = 0
    let disposeCalls = 0
    const mcpManager: RunJobMcpManager = {
      async loadEager() {
        loadEagerCalls++
        return { eagerCount: 0, lazyCount: 0 }
      },
      async dispose() {
        disposeCalls++
      },
    }

    const provider = createStubProvider({
      responses: [{ text: 'quick answer', toolCalls: [] }],
    })
    const registry = new ToolRegistry()

    const result = await runJob(
      'zero-mcp',
      { prompt: 'hi' },
      {
        home: tmpHome,
        kcConfig: kc(),
        provider,
        registry,
        mcpManager,
        now: () => new Date('2026-04-08T16:00:00.000Z'),
      },
    )

    expect(result.exitReason).toBe('natural')
    expect(loadEagerCalls).toBe(1)
    // Dispose must fire exactly once — not zero (would leak), not two
    // (would double-dispose if finally + signal handler both ran).
    expect(disposeCalls).toBe(1)
  })

  test('dispose fires once even when runSubagent throws', async () => {
    let disposeCalls = 0
    const mcpManager: RunJobMcpManager = {
      async loadEager() {
        throw new Error('simulated mcp boot failure')
      },
      async dispose() {
        disposeCalls++
      },
    }
    const provider = createStubProvider({ responses: [{ text: 'x', toolCalls: [] }] })
    const registry = new ToolRegistry()

    const result = await runJob(
      'mcp-fail',
      { prompt: 'hi' },
      {
        home: tmpHome,
        kcConfig: kc(),
        provider,
        registry,
        mcpManager,
        now: () => new Date('2026-04-08T17:00:00.000Z'),
      },
    )

    expect(result.error).toBeTruthy()
    expect(result.error?.message).toContain('simulated mcp boot failure')
    expect(disposeCalls).toBe(1)
  })
})
