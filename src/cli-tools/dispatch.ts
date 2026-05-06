import type { ToolContext, ToolResult } from '../tools/types.js'
import type { CliToolConfig } from '../config/types.js'
import type { TrustTier } from '../security/trust-tiers.js'
import type { SandboxStatus } from '../security/audit.js'
import { validateArgString } from './validate.js'
import { parseArgString } from './parse-args.js'
import { resolveSubCommandTier } from './resolve-tier.js'
import { getPlatformSandbox } from '../tools/sandbox/index.js'
import { hashArgs, appendAuditEntry } from '../security/audit.js'
import { truncateResult } from '../utils/truncate.js'

// Phase 20 (LEAN-02), plan 03: the real dispatch path for CLI tools. Glue
// between the pure logic (plan 01), the tool surface (plan 02), and the
// Phase 17 sandbox + Phase 18 audit infrastructure.
//
// Flow: validate → parse → resolve tier → summary → sandbox wrap (or bypass)
//       → spawn → timeout → stdout/stderr assembly → truncate → audit.
//
// Mirrors src/tools/builtin/bash.ts for the sandbox matrix, timeout handling,
// and result shape — see that file for the canonical decision matrix.
//
// NO shell, NO exec, NO interpolation. Single process, single argv (decision 3).

export type SpawnFn = (
  args: string[],
  opts: Parameters<typeof Bun.spawn>[1],
) => ReturnType<typeof Bun.spawn>

export interface CliDispatchResult extends ToolResult {
  __sandboxStatus?: SandboxStatus
  __resolvedTier?: TrustTier
  __commandSummary?: string
  /** Test-only: pending audit flush. The agent loop strips this before forwarding. */
  __auditPromise?: Promise<void>
}

/**
 * Build the command summary shown in the permission prompt.
 * Per decision 9: show first sub-command only, not the full arg string.
 * Example: `gh pr list --state open` → `gh pr list`
 */
export function buildCommandSummary(command: string, argv: string[]): string {
  const head = argv.slice(0, 2).join(' ')
  return head ? `${command} ${head}` : command
}

/**
 * Decide sandbox wrap args and status — mirrors buildBashInvocation in bash.ts.
 * Extracted so the matrix stays in one file's head at a time.
 */
function buildCliInvocation(
  command: string,
  argv: string[],
  ctx: ToolContext,
): { args: string[]; sandboxStatus: SandboxStatus; failClosed: boolean } {
  const isYolo = ctx.mode === 'yolo'

  if (process.platform !== 'darwin') {
    return { args: [command, ...argv], sandboxStatus: 'n/a', failClosed: false }
  }

  const sandboxUnavailable = ctx.sandboxAvailable === false

  if (sandboxUnavailable) {
    if (isYolo) {
      return { args: [command, ...argv], sandboxStatus: 'unavailable', failClosed: false }
    }
    return { args: [], sandboxStatus: 'unavailable', failClosed: true }
  }

  if (isYolo) {
    return { args: [command, ...argv], sandboxStatus: 'bypassed', failClosed: false }
  }

  const sandbox = getPlatformSandbox()
  const wrapped = sandbox.wrap(command, argv, {
    network: false, // CLI tools don't expose network opt-in; closest-to-safe default
    cwd: ctx.cwd,
    tmpdir: ctx.sessionTmpdir ?? '/tmp',
  })
  return { args: wrapped, sandboxStatus: 'enforced', failClosed: false }
}

export async function executeCliTool(
  name: string,
  cfg: CliToolConfig,
  rawArgs: string,
  ctx: ToolContext,
  spawnFn: SpawnFn = Bun.spawn as unknown as SpawnFn,
): Promise<CliDispatchResult> {
  // 1. Validate — reject before spawn, no audit entry (nothing executed)
  const rejectReason = validateArgString(rawArgs)
  if (rejectReason) {
    return { content: `Rejected arg: ${rejectReason}`, isError: true }
  }

  // 2. Parse
  const argv = parseArgString(rawArgs)

  // 3. Resolve tier
  const resolvedTier = resolveSubCommandTier(argv, cfg)

  // 4. Command summary (for permission prompt + result hint)
  const commandSummary = buildCommandSummary(cfg.command, argv)

  // 5 + 6. Sandbox wrap / bypass matrix
  const { args: spawnArgs, sandboxStatus, failClosed } = buildCliInvocation(
    cfg.command, argv, ctx,
  )

  if (failClosed) {
    return {
      content:
        `sandbox-exec is not available on this system. CLI tool '${name}' is disabled ` +
        `in ${ctx.mode ?? 'ask'} mode. Re-run with yolo mode to bypass ` +
        `(you will see a [sandbox: UNAVAILABLE] prefix on results).`,
      isError: true,
      __sandboxStatus: 'unavailable',
      __resolvedTier: resolvedTier,
      __commandSummary: commandSummary,
    }
  }

  const timeoutMs = ctx.toolTimeoutMs
  const startedAt = Date.now()
  let timedOut = false
  let proc: ReturnType<typeof Bun.spawn> | null = null

  // Helper: fire-and-forget audit write — promise captured for test awaitability
  let auditPromise: Promise<void> = Promise.resolve()
  const writeAudit = (exitCode: number, resultSize: number) => {
    auditPromise = appendAuditEntry({
      ts: new Date().toISOString(),
      kind: 'tool_call',
      sessionId: ctx.sessionId ?? 'unknown',
      platform: process.platform,
      tool: `cli:${name}`,
      tier: resolvedTier,
      argsHash: hashArgs(rawArgs),
      resultSize,
      durationMs: Date.now() - startedAt,
      mode: ctx.mode ?? 'ask',
      exitCode,
      sandbox: sandboxStatus,
    }).catch(() => {})
  }

  try {
    proc = spawnFn(spawnArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      cwd: ctx.cwd,
      env: {
        ...process.env,
        KC_TMPDIR: ctx.sessionTmpdir ?? '',
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      if (proc && proc.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-proc.pid, 'SIGTERM')
          } else {
            proc.kill()
          }
        } catch {
          try { proc.kill() } catch {}
        }
      }
    }, timeoutMs)

    await proc.exited
    clearTimeout(timer)

    if (timedOut) {
      const content = `Command timed out after ${timeoutMs}ms`
      writeAudit(1, content.length)
      return {
        content,
        isError: true,
        __sandboxStatus: sandboxStatus,
        __resolvedTier: resolvedTier,
        __commandSummary: commandSummary,
        __auditPromise: auditPromise,
      }
    }

    const [stdout, stderr] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proc.stdout ? new Response(proc.stdout as any).text() : Promise.resolve(''),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proc.stderr ? new Response(proc.stderr as any).text() : Promise.resolve(''),
    ])

    const exitCode = proc.exitCode ?? 0
    let combined = stdout
    if (stderr) combined += '\nSTDERR:\n' + stderr
    if (exitCode !== 0) combined += `\nExit code: ${exitCode}`

    let content = truncateResult(combined.trim())

    if (sandboxStatus === 'bypassed') {
      content = '[sandbox: BYPASSED]\n' + content
    } else if (sandboxStatus === 'unavailable') {
      content = '[sandbox: UNAVAILABLE]\n' + content
    }

    writeAudit(exitCode !== 0 ? 1 : 0, content.length)

    return {
      content,
      isError: exitCode !== 0,
      __sandboxStatus: sandboxStatus,
      __resolvedTier: resolvedTier,
      __commandSummary: commandSummary,
      __auditPromise: auditPromise,
    }
  } catch (err) {
    const content = `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`
    writeAudit(1, content.length)
    return {
      content,
      isError: true,
      __sandboxStatus: sandboxStatus,
      __resolvedTier: resolvedTier,
      __commandSummary: commandSummary,
      __auditPromise: auditPromise,
    }
  }
}
