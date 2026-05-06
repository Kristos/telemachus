/**
 * Phase 22-03 (AGENT-03): end-to-end CLI wiring smoke test.
 *
 * Two pieces:
 *   1. Structural assertion: src/index.ts main() branches on argv[2]==='agent'
 *      BEFORE the TTY guard. Catches regression if someone reorders main().
 *   2. In-process smoke: mock `createProvider` via `mock.module`, point HOME
 *      at a tmpdir with a minimal agents config, call runAgentSubcommand and
 *      assert real artifacts land on disk.
 *
 * Why in-process instead of `bun run src/index.ts`: spawning a subprocess
 * would need a stub provider baked into the binary (too invasive for this
 * phase). In-process exercises the same dispatch logic and produces the
 * same real artifact files via the real runJob.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createStubProvider } from '../fixtures/stub-provider.js'

// ————— exit capture —————

class ExitError extends Error {
  code: number
  constructor(code: number) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

let origExit: typeof process.exit
let origHome: string | undefined
let origStderrWrite: typeof process.stderr.write
let tmpHome: string
let stderrBuf: string

beforeEach(() => {
  stderrBuf = ''
  origStderrWrite = process.stderr.write.bind(process.stderr)
  // @ts-ignore
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  origExit = process.exit
  // @ts-ignore
  process.exit = (code?: number): never => {
    throw new ExitError(code ?? 0)
  }

  origHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cli-'))
  fs.mkdirSync(path.join(tmpHome, '.telemachus'), { recursive: true })
  process.env.HOME = tmpHome
})

afterEach(async () => {
  process.stderr.write = origStderrWrite
  process.exit = origExit
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

// ————— 1. Structural assertion —————

describe('src/index.ts agent branch structural position', () => {
  test('argv[2]===agent branch appears before isTTY guard', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '..', '..', 'src', 'index.ts'),
      'utf8',
    )
    const mainStart = src.indexOf('async function main()')
    expect(mainStart).toBeGreaterThan(-1)

    const body = src.slice(mainStart)
    const agentBranchIdx = body.indexOf("process.argv[2] === 'agent'")
    const ttyGuardIdx = body.indexOf('!process.stdin.isTTY')

    expect(agentBranchIdx).toBeGreaterThan(-1)
    expect(ttyGuardIdx).toBeGreaterThan(-1)
    expect(agentBranchIdx).toBeLessThan(ttyGuardIdx)
  })
})

// ————— 2. In-process smoke via mock.module —————

describe('runAgentSubcommand end-to-end smoke', () => {
  test('run <job> produces real artifacts with mocked provider', async () => {
    // Stub provider returning a single natural-termination response
    const stub = createStubProvider({
      responses: [{ text: 'smoke test ok', toolCalls: [] }],
    })

    // Mock the provider registry BEFORE importing the dispatcher
    mock.module('../../src/providers/registry.js', () => ({
      createProvider: () => stub,
    }))

    // Minimal config with one agent job — permissionMode must satisfy
    // AgentJobConfig (narrowed to 'yolo' | 'agent').
    fs.writeFileSync(
      path.join(tmpHome, '.telemachus', 'config.json'),
      JSON.stringify({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agents: {
          smoke: {
            prompt: 'smoke test prompt',
            permissionMode: 'agent',
            maxIterations: 3,
          },
        },
      }),
    )

    // Fresh import so the mock takes effect
    const { runAgentSubcommand } = await import(
      '../../src/agent-runner/index.js?cli-smoke=' + Date.now()
    )

    let exitCode: number | null = null
    try {
      await runAgentSubcommand(['run', 'smoke'])
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code
      else throw err
    }

    expect(exitCode).toBe(0)
    expect(stub.callCount).toBe(1)
    expect(stderrBuf).toContain('Run complete:')

    // Real artifacts landed on disk
    const jobDir = path.join(tmpHome, '.telemachus', 'agent-runs', 'smoke')
    expect(fs.existsSync(jobDir)).toBe(true)

    const runDirs = fs
      .readdirSync(jobDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(runDirs.length).toBe(1)

    const runDir = path.join(jobDir, runDirs[0]!)
    expect(fs.existsSync(path.join(runDir, 'log.txt'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'result.md'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'usage.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'config.json'))).toBe(true)

    // latest symlink resolves
    const latest = await fsp.readlink(path.join(jobDir, 'latest'))
    expect(latest).toBe(runDirs[0])

    const usage = JSON.parse(
      await fsp.readFile(path.join(runDir, 'usage.json'), 'utf8'),
    )
    expect(usage.exit_reason).toBe('natural')

    const resultText = await fsp.readFile(path.join(runDir, 'result.md'), 'utf8')
    expect(resultText.length).toBeGreaterThan(0)
    expect(resultText).toContain('smoke test ok')
  })
})
