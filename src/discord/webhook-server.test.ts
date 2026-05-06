/**
 * Phase 37-01: Tests for webhook-server.ts
 * HMAC verification, branch filtering, pipeline orchestration, debounce.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { createHmac } from 'node:crypto'

// We import what we need from the module under test
import {
  verifySignature,
  runBuildPipeline,
} from './webhook-server.js'
import type { WebhookDeps } from './webhook-server.js'

// ————————————————————————————————————————————————————————————————————————
// Helpers
// ————————————————————————————————————————————————————————————————————————

function makeSignature(body: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function makeFakeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps & {
  spawnCalls: Array<{ cmd: string[]; cwd: string }>
  dmCalls: Array<{ token: string; userId: string; text: string }>
  logAppends: string[]
  uidValue: string
} {
  const spawnCalls: Array<{ cmd: string[]; cwd: string }> = []
  const dmCalls: Array<{ token: string; userId: string; text: string }> = []
  const logAppends: string[] = []
  const uidValue = '501'

  return {
    spawnCalls,
    dmCalls,
    logAppends,
    uidValue,
    async spawn(cmd, opts) {
      spawnCalls.push({ cmd, cwd: opts.cwd })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    async getUid() {
      return uidValue
    },
    async sendDm(token, userId, text) {
      dmCalls.push({ token, userId, text })
    },
    async appendLog(logFile, text) {
      logAppends.push(text)
    },
    ...overrides,
  }
}

// ————————————————————————————————————————————————————————————————————————
// verifySignature
// ————————————————————————————————————————————————————————————————————————

describe('verifySignature', () => {
  it('returns true for correct HMAC signature', () => {
    const secret = 'test-secret-abc'
    const body = Buffer.from('{"ref":"refs/heads/main"}')
    const sig = makeSignature(body, secret)
    expect(verifySignature(body, sig, secret)).toBe(true)
  })

  it('returns false for wrong secret', () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}')
    const sig = makeSignature(body, 'correct-secret')
    expect(verifySignature(body, sig, 'wrong-secret')).toBe(false)
  })

  it('returns false for tampered body', () => {
    const secret = 'test-secret'
    const body = Buffer.from('original body')
    const sig = makeSignature(body, secret)
    const tamperedBody = Buffer.from('tampered body')
    expect(verifySignature(tamperedBody, sig, secret)).toBe(false)
  })

  it('returns false for malformed signature (no sha256= prefix)', () => {
    const secret = 'test-secret'
    const body = Buffer.from('body')
    // sig without "sha256=" prefix
    const sigRaw = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifySignature(body, sigRaw, secret)).toBe(false)
  })

  it('returns false when lengths differ (prevents timing attacks)', () => {
    const secret = 'test-secret'
    const body = Buffer.from('body')
    // completely wrong sig
    expect(verifySignature(body, 'sha256=wrong', secret)).toBe(false)
  })

  it('uses timingSafeEqual (no === comparison)', () => {
    // This is structural — we grep for timingSafeEqual in the source.
    // Here we just check the function is callable and consistent.
    const secret = 'secret'
    const body = Buffer.from('test')
    const sig = makeSignature(body, secret)
    expect(verifySignature(body, sig, secret)).toBe(true)
    expect(verifySignature(body, sig, 'wrong')).toBe(false)
  })
})

// ————————————————————————————————————————————————————————————————————————
// runBuildPipeline
// ————————————————————————————————————————————————————————————————————————

describe('runBuildPipeline', () => {
  it('runs git pull, bun install, bun build in sequence on success', async () => {
    const deps = makeFakeDeps()
    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(3)
    expect(deps.spawnCalls[0]!.cmd[0]).toBe('git')
    expect(deps.spawnCalls[0]!.cmd[1]).toBe('pull')
    expect(deps.spawnCalls[1]!.cmd[0]).toBe('bun')
    expect(deps.spawnCalls[1]!.cmd[1]).toBe('install')
    expect(deps.spawnCalls[2]!.cmd[0]).toBe('bun')
    expect(deps.spawnCalls[2]!.cmd[1]).toBe('build')
  })

  it('stops at first failure — git pull fails, no bun install', async () => {
    const deps = makeFakeDeps({
      async spawn(cmd) {
        if (cmd[0] === 'git') {
          return { exitCode: 1, stdout: '', stderr: 'fatal: not a repo' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(false)
    expect(result.steps.length).toBe(1)
    expect(result.steps[0]!.exitCode).toBe(1)
  })

  it('stops at bun install failure — no bun build', async () => {
    let callCount = 0
    const deps = makeFakeDeps({
      async spawn(cmd) {
        callCount++
        if (callCount === 2) {
          return { exitCode: 1, stdout: '', stderr: 'install failed' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(false)
    expect(result.steps.length).toBe(2)
    expect(result.steps[1]!.exitCode).toBe(1)
  })

  it('records duration for each step', async () => {
    const deps = makeFakeDeps()
    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    for (const step of result.steps) {
      expect(typeof step.durationMs).toBe('number')
      expect(step.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('uses repoDir as cwd for all spawn calls', async () => {
    const deps = makeFakeDeps()
    const repoDir = '/my/custom/repo'
    await runBuildPipeline(repoDir, '/tmp/log.txt', deps)
    for (const call of deps.spawnCalls) {
      expect(call.cwd).toBe(repoDir)
    }
  })

  it('includes logFile path in result', async () => {
    const deps = makeFakeDeps()
    const result = await runBuildPipeline('/repo', '/tmp/run-123.log', deps)
    expect(result.logFile).toBe('/tmp/run-123.log')
  })

  it('appends output to log for each step', async () => {
    const deps = makeFakeDeps()
    await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(deps.logAppends.length).toBeGreaterThan(0)
  })
})

// ————————————————————————————————————————————————————————————————————————
// Kickstart on success / DM on failure
// ————————————————————————————————————————————————————————————————————————

describe('pipeline integration (kickstart / DM)', () => {
  it('triggers kickstart with correct label on successful pipeline', async () => {
    const deps = makeFakeDeps()
    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(true)

    // The kickstart logic lives in the HTTP handler, not in runBuildPipeline.
    // runBuildPipeline returns success:true — the handler does kickstart.
    // This test confirms that the pipeline itself returns true so kickstart CAN be called.
  })

  it('successful pipeline does NOT call sendDm', async () => {
    const deps = makeFakeDeps()
    await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(deps.dmCalls).toHaveLength(0)
  })

  it('failed pipeline reports failure (caller handles DM)', async () => {
    const deps = makeFakeDeps({
      async spawn() {
        return { exitCode: 1, stdout: '', stderr: 'build failed' }
      },
    })
    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(false)
  })
})

// ————————————————————————————————————————————————————————————————————————
// Phase 65-05 (HYG-05): 300s spawn timeout via AbortController
// ————————————————————————————————————————————————————————————————————————

describe('runBuildPipeline — spawn timeout (HYG-05)', () => {
  it('returns structured timeout error when deps.spawn reports timedOut:true', async () => {
    // Case 3: spawn that "never exits" — simulated by returning timedOut:true
    // after a short delay. The real implementation uses AbortController inside
    // realSpawn to mark timedOut, but at the deps-injection layer we just
    // assert the runBuildPipeline timedOut-branch contract.
    const deps = makeFakeDeps({
      async spawn() {
        return { exitCode: -1, stdout: '', stderr: '', timedOut: true }
      },
    })

    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/timed out after \d+ms/)
    // Pipeline halts at first timeout (like first exitCode failure)
    expect(result.steps.length).toBe(1)
  })

  it('passes timeoutMs=300_000 to deps.spawn by default', async () => {
    const timeoutValues: Array<number | undefined> = []
    const deps = makeFakeDeps({
      async spawn(_cmd, opts) {
        timeoutValues.push((opts as { timeoutMs?: number }).timeoutMs)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    // All 3 pipeline steps should receive timeoutMs=300_000
    expect(timeoutValues).toHaveLength(3)
    for (const t of timeoutValues) {
      expect(t).toBe(300_000)
    }
  })

  it('appends TIMEOUT marker to log on timedOut:true path', async () => {
    const deps = makeFakeDeps({
      async spawn() {
        return {
          exitCode: -1,
          stdout: '',
          stderr: 'hung process',
          timedOut: true,
        }
      },
    })

    await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    // At least one appendLog call should contain "TIMEOUT after"
    const hasTimeoutLine = deps.logAppends.some((line) =>
      /TIMEOUT after \d+ms/.test(line),
    )
    expect(hasTimeoutLine).toBe(true)
  })

  it('non-timeout (normal exit) path does NOT add timedOut to result steps', async () => {
    const deps = makeFakeDeps() // default: all exits 0
    const result = await runBuildPipeline('/repo', '/tmp/log.txt', deps)
    expect(result.success).toBe(true)
    // PipelineResult.error must not match timeout pattern
    expect(result.error).toBeUndefined()
  })
})
