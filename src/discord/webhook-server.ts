/**
 * Phase 37-01 (UPDATE-01, UPDATE-02, UPDATE-03): GitHub webhook HTTP server.
 *
 * Receives GitHub push webhooks, verifies HMAC-SHA256, runs build pipeline,
 * and restarts the Discord bot via launchctl kickstart -k on success.
 *
 * Security pitfalls addressed:
 *   W1: Read body as raw bytes FIRST, verify HMAC, THEN JSON.parse.
 *   W2: Use timingSafeEqual — never === for HMAC comparison.
 *   W6: Bind to 127.0.0.1 only.
 *   W7: Filter on payload.ref === config.targetRef.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { homedir } from 'node:os'
import type { WebhookConfig, PipelineResult } from './webhook-types.js'

// Phase 65 (HYG-05): default per-spawn timeout. Hung network (git pull) or
// stuck registry (bun install) cannot wedge the webhook server beyond 5min.
export const DEFAULT_SPAWN_TIMEOUT_MS = 300_000

// Dependency injection interface for testability

export interface WebhookDeps {
  spawn: (
    cmd: string[],
    opts: { cwd: string; timeoutMs?: number },
  ) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    timedOut?: boolean
  }>
  getUid: () => Promise<string>
  sendDm: (token: string, userId: string, text: string) => Promise<void>
  appendLog: (logFile: string, text: string) => Promise<void>
}

// Default real implementations

async function realSpawn(
  cmd: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
}> {
  const [bin, ...args] = cmd
  const ac = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
  const timer = setTimeout(() => ac.abort(`timeout after ${timeoutMs}ms`), timeoutMs)
  try {
    const proc = Bun.spawn([bin!, ...args], {
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // AbortController signal — Bun.spawn kills the child when fired.
      signal: ac.signal,
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    const timedOut = ac.signal.aborted
    return { exitCode: proc.exitCode ?? -1, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function realGetUid(): Promise<string> {
  const proc = Bun.spawn(['id', '-u'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function realAppendLog(logFile: string, text: string): Promise<void> {
  await fs.appendFile(logFile, text + '\n')
}

// HMAC verification (UPDATE-01) — W1: raw bytes before HMAC, W2: timingSafeEqual

export function verifySignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  // Signature must start with "sha256="
  if (!signature.startsWith('sha256=')) {
    return false
  }

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expected)

  // Buffers must be equal length before timingSafeEqual
  if (sigBuf.length !== expBuf.length) {
    return false
  }

  return timingSafeEqual(sigBuf, expBuf)
}

// Build pipeline (UPDATE-02): git pull → bun install --frozen-lockfile → bun build

const PIPELINE_STEPS = [
  { name: 'git pull', cmd: ['git', 'pull'] },
  { name: 'bun install', cmd: ['bun', 'install', '--frozen-lockfile'] },
  {
    name: 'bun build',
    cmd: ['bun', 'build', './src/index.ts', '--outdir', 'dist', '--target', 'bun'],
  },
]

export async function runBuildPipeline(
  repoDir: string,
  logFile: string,
  deps: WebhookDeps = realDeps,
): Promise<PipelineResult> {
  const steps: PipelineResult['steps'] = []
  let firstError: string | undefined

  for (const step of PIPELINE_STEPS) {
    const start = Date.now()
    const result = await deps.spawn(step.cmd, {
      cwd: repoDir,
      timeoutMs: DEFAULT_SPAWN_TIMEOUT_MS,
    })
    const durationMs = Date.now() - start

    // Phase 65 (HYG-05): timeout branch takes precedence over exitCode.
    // realSpawn's AbortController marks timedOut=true when the 300s timer
    // fires; the pipeline fast-fails with a structured error so the
    // webhook handler can DM the owner via the existing error path.
    if (result.timedOut) {
      const timeoutMsg = `Step '${step.name}' timed out after ${DEFAULT_SPAWN_TIMEOUT_MS}ms`
      await deps.appendLog(
        logFile,
        `=== ${step.name} (TIMEOUT after ${DEFAULT_SPAWN_TIMEOUT_MS}ms) ===\n${result.stderr}`,
      )
      steps.push({ name: step.name, exitCode: result.exitCode, durationMs, timedOut: true })
      return { success: false, steps, logFile, error: timeoutMsg }
    }

    const logEntry = [
      `=== ${step.name} (exit ${result.exitCode}, ${durationMs}ms) ===`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join('\n')
    await deps.appendLog(logFile, logEntry)

    steps.push({ name: step.name, exitCode: result.exitCode, durationMs })

    if (result.exitCode !== 0) {
      firstError = `Step '${step.name}' failed with exit code ${result.exitCode}: ${result.stderr.trim()}`
      return { success: false, steps, logFile, error: firstError }
    }
  }

  return { success: true, steps, logFile }
}

// Discord REST DM for failure notifications (two fetch calls, no discord.js)

export async function sendFailureDm(
  tokenEnvName: string,
  ownerId: string,
  error: string,
): Promise<void> {
  const token = process.env[tokenEnvName]
  if (!token) {
    process.stderr.write(`Webhook: cannot send DM — ${tokenEnvName} not set\n`)
    return
  }

  try {
    // 1. Open DM channel
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: ownerId }),
    })

    if (!dmRes.ok) {
      process.stderr.write(
        `Webhook: failed to create DM channel (${dmRes.status})\n`,
      )
      return
    }

    const channel = (await dmRes.json()) as { id: string }

    // 2. Send message
    const msgRes = await fetch(
      `https://discord.com/api/v10/channels/${channel.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: `[Auto-update failed]\n${error}` }),
      },
    )

    if (!msgRes.ok) {
      process.stderr.write(
        `Webhook: failed to send DM message (${msgRes.status})\n`,
      )
    }
  } catch (err) {
    process.stderr.write(
      `Webhook: DM send error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

// Real deps singleton (used as default parameter)

const realDeps: WebhookDeps = {
  spawn: realSpawn,
  getUid: realGetUid,
  sendDm: async (token, userId, text) => {
    // token here is the env var name — pass through to sendFailureDm
    await sendFailureDm(token, userId, text)
  },
  appendLog: realAppendLog,
}

// Webhook HTTP server (UPDATE-02, UPDATE-03) — binds to 127.0.0.1 only (W6)

export function startWebhookServer(
  config: WebhookConfig,
  deps: WebhookDeps = realDeps,
): { server: ReturnType<typeof Bun.serve>; stop: () => void } {
  let pipelineRunning = false

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: config.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }

      // Only POST / handled
      if (req.method !== 'POST' || url.pathname !== '/') {
        return new Response('Not Found', { status: 404 })
      }

      // W1: Read raw bytes FIRST — before any JSON parsing
      const rawBody = Buffer.from(await req.arrayBuffer())

      // UPDATE-01: Verify HMAC-SHA256 signature
      const signature = req.headers.get('x-hub-signature-256') ?? ''
      if (!verifySignature(rawBody, signature, config.webhookSecret)) {
        return new Response('Unauthorized', { status: 401 })
      }

      // Parse JSON only after HMAC passes
      let payload: { ref?: string }
      try {
        payload = JSON.parse(rawBody.toString('utf8'))
      } catch {
        return new Response('Bad Request', { status: 400 })
      }

      // W7: Only process target branch (default refs/heads/main)
      if (payload.ref !== config.targetRef) {
        return new Response('ignored', { status: 200 })
      }

      // Debounce: return early if pipeline already running
      if (pipelineRunning) {
        return new Response('pipeline already running', { status: 200 })
      }

      // UPDATE-02: Acknowledge immediately, pipeline runs async
      const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
      const runDir = path.join(homedir(), '.telemachus', 'webhook-runs')
      const logFile = path.join(runDir, `${isoStamp}.log`)

      // Fire-and-forget pipeline
      void (async () => {
        pipelineRunning = true
        try {
          await fs.mkdir(runDir, { recursive: true })
          const result = await runBuildPipeline(config.repoDir, logFile, deps)

          if (result.success) {
            // UPDATE-03: Restart Discord bot via launchctl kickstart -k
            const uid = await deps.getUid()
            await deps.spawn(
              ['launchctl', 'kickstart', '-k', `gui/${uid}/com.telemachus.discord`],
              { cwd: '/' },
            )
            process.stderr.write(
              `Webhook: build succeeded, kicked com.telemachus.discord\n`,
            )
            // Self-restart: exit so launchd KeepAlive restarts us with the new binary
            process.stderr.write('Webhook: exiting for self-update (launchd will restart)\n')
            setTimeout(() => process.exit(0), 1000)
          } else {
            const errMsg = result.error ?? 'Build pipeline failed'
            process.stderr.write(`Webhook: build FAILED — ${errMsg}\n`)
            await deps.sendDm(config.discordTokenEnv, config.ownerId, errMsg)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Webhook: pipeline error — ${msg}\n`)
          await deps.sendDm(config.discordTokenEnv, config.ownerId, msg)
        } finally {
          pipelineRunning = false
        }
      })()

      return new Response('ok', { status: 200 })
    },
  })

  process.stderr.write(`Webhook: listening on 127.0.0.1:${config.port}\n`)

  return {
    server,
    stop: () => server.stop(),
  }
}
