import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeCliTool, type SpawnFn } from './dispatch.js'
import type { CliToolConfig } from '../config/types.js'
import type { ToolContext } from '../tools/types.js'

// Fake spawn: records the call, returns a fake process with configurable
// stdout/stderr/exit code. Mirrors the shape Bun.spawn returns that bash.ts uses.
interface FakeSpawnCall {
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

function makeFakeSpawn(opts: {
  stdout?: string
  stderr?: string
  exitCode?: number
  delay?: number
}): { spawn: SpawnFn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = []
  const spawn: SpawnFn = (args, spawnOpts) => {
    calls.push({
      args: [...args],
      cwd: spawnOpts?.cwd as string | undefined,
      env: spawnOpts?.env as Record<string, string | undefined> | undefined,
    })
    const stdoutText = opts.stdout ?? ''
    const stderrText = opts.stderr ?? ''
    const exitCode = opts.exitCode ?? 0
    let settled = false
    const exited: Promise<number> = new Promise((resolve) => {
      const fire = () => {
        settled = true
        resolve(exitCode)
      }
      if (opts.delay) setTimeout(fire, opts.delay)
      else fire()
    })
    return {
      pid: 12345,
      stdout: new Response(stdoutText).body,
      stderr: new Response(stderrText).body,
      stdin: null,
      exited,
      exitCode: opts.delay ? null : exitCode,
      kill: () => {
        if (!settled) {
          settled = true
        }
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }
  return { spawn, calls }
}

let tmpHome: string
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kc-dispatch-test-'))
  process.env.HOME = tmpHome
})
afterEach(async () => {
  // Let any pending fire-and-forget audit writes flush before we rm the dir
  await new Promise((r) => setTimeout(r, 20))
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

const baseCtx: ToolContext = {
  cwd: '/tmp',
  toolTimeoutMs: 5000,
  askUser: async () => 'ok',
  sessionId: 'sess-test',
  mode: 'yolo', // bypass sandbox in tests — we're not exercising sandbox matrix here
  sessionTmpdir: '/tmp/kc-sess-test',
  sandboxAvailable: true,
}

const ghCfg: CliToolConfig = {
  command: 'gh',
  description: 'GitHub CLI',
  trustTier: 'risky',
}

describe('executeCliTool', () => {
  test('1. clean args spawn command with parsed argv', async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: 'PR list output', exitCode: 0 })
    const result = await executeCliTool('gh', ghCfg, 'pr list', baseCtx, spawn)
    expect(calls.length).toBe(1)
    expect(calls[0]!.args).toEqual(['gh', 'pr', 'list'])
    expect(result.isError).toBe(false)
    expect(result.content).toContain('PR list output')
  })

  test('2. metachar rejection: no spawn, no audit, error result', async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: '' })
    const result = await executeCliTool('gh', ghCfg, 'pr list; rm -rf /', baseCtx, spawn)
    expect(calls.length).toBe(0)
    expect(result.isError).toBe(true)
    expect(result.content.toLowerCase()).toContain('reject')
    expect(result.content).toContain(';')
    // Audit file should not exist — nothing executed
    const auditDir = join(tmpHome, '.telemachus', 'audit')
    expect(existsSync(auditDir)).toBe(false)
  })

  test('3. quoted arg parses correctly', async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: 'ok' })
    await executeCliTool('gh', ghCfg, 'pr create --title "hello world"', baseCtx, spawn)
    expect(calls[0]!.args).toEqual(['gh', 'pr', 'create', '--title', 'hello world'])
  })

  test('4. sub-command tier resolution attaches __resolvedTier', async () => {
    const { spawn } = makeFakeSpawn({ stdout: 'merged' })
    const cfg: CliToolConfig = {
      command: 'gh',
      description: 'gh',
      trustTier: 'risky',
      subCommandTiers: { 'pr merge': 'dangerous' },
    }
    const result = await executeCliTool('gh', cfg, 'pr merge 123', baseCtx, spawn)
    expect(result.__resolvedTier).toBe('dangerous')
  })

  test('5. default tier fallback when no sub-command match', async () => {
    const { spawn } = makeFakeSpawn({ stdout: 'ok' })
    const cfg: CliToolConfig = { command: 'gh', description: 'gh' } // no trustTier → dangerous
    const result = await executeCliTool('gh', cfg, 'status', baseCtx, spawn)
    expect(result.__resolvedTier).toBe('dangerous')
  })

  test('6. audit entry written with tool=cli:gh and argsHash', async () => {
    const { spawn } = makeFakeSpawn({ stdout: 'ok' })
    const r = await executeCliTool('gh', ghCfg, 'pr list', baseCtx, spawn)
    await r.__auditPromise
    const auditDir = join(tmpHome, '.telemachus', 'audit')
    expect(existsSync(auditDir)).toBe(true)
    // Find the jsonl file
    const files = require('node:fs').readdirSync(auditDir)
    expect(files.length).toBeGreaterThan(0)
    const line = readFileSync(join(auditDir, files[0]), 'utf8').trim()
    const entry = JSON.parse(line)
    expect(entry.tool).toBe('cli:gh')
    expect(entry.tier).toBe('risky')
    expect(entry.argsHash).toMatch(/^sha256:/)
  })

  test('7. non-zero exit returns isError=true with code in content', async () => {
    const { spawn } = makeFakeSpawn({ stdout: '', stderr: 'not found', exitCode: 2 })
    const result = await executeCliTool('gh', ghCfg, 'bogus', baseCtx, spawn)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('2')
  })

  test('8. command summary is first two tokens', async () => {
    const { spawn } = makeFakeSpawn({ stdout: 'ok' })
    const result = await executeCliTool('gh', ghCfg, 'pr list --state open', baseCtx, spawn)
    expect(result.__commandSummary).toBe('gh pr list')
  })

  test('9. yolo mode sandbox status is platform-aware', async () => {
    const { spawn } = makeFakeSpawn({ stdout: 'output' })
    const result = await executeCliTool('gh', ghCfg, 'pr list', baseCtx, spawn)
    if (process.platform === 'darwin') {
      // macOS: sandbox-exec available, yolo bypasses it
      expect(result.content).toContain('[sandbox: BYPASSED]')
      expect(result.__sandboxStatus).toBe('bypassed')
    } else {
      // Linux/other: no sandbox-exec, status is n/a
      expect(result.__sandboxStatus).toBe('n/a')
      expect(result.content).not.toContain('[sandbox: BYPASSED]')
    }
  })
})
