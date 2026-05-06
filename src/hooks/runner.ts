import type { HookCommand, HookEvent } from './types'

export interface HookRunResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  blocked: boolean
}

const DEFAULT_TIMEOUT_SEC = 30

async function runOne(event: HookEvent, cmd: HookCommand): Promise<HookRunResult> {
  const start = Date.now()
  const timeoutMs = (cmd.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000

  try {
    const proc = Bun.spawn(['sh', '-c', cmd.command], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill()
        } catch {}
        resolve()
      }, timeoutMs)
    })

    await Promise.race([proc.exited, timeoutPromise])
    if (timer) clearTimeout(timer)

    // Ensure process is finished after kill
    if (timedOut) {
      try {
        await proc.exited
      } catch {}
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ])

    const exitCode = timedOut ? -1 : (proc.exitCode ?? -1)
    const blocked = event === 'PreToolUse' && (timedOut || exitCode !== 0)

    return {
      command: cmd.command,
      exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - start,
      blocked,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const exitCode = -1
    return {
      command: cmd.command,
      exitCode,
      stdout: '',
      stderr: message,
      timedOut: false,
      durationMs: Date.now() - start,
      blocked: event === 'PreToolUse',
    }
  }
}

export async function runHooks(
  event: HookEvent,
  _toolName: string,
  commands: HookCommand[],
): Promise<HookRunResult[]> {
  const results: HookRunResult[] = []
  for (const cmd of commands) {
    results.push(await runOne(event, cmd))
  }
  return results
}
