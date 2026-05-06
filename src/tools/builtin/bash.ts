import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { truncateResult } from '../../utils/truncate.js'
import { getPlatformSandbox } from '../sandbox/index.js'
import type { SandboxStatus } from '../../security/audit.js'

// NOTE: the permission prompt is UX — it helps the owner avoid mistakes and
// surfaces the command summary for review. The sandbox is security — it
// prevents execution of commands that would escape the cwd+tmp scope or
// reach the network without opt-in.
//
// Do not confuse the two. A user-facing "exclude" list (if we add one later)
// is convenience, not security. The sandbox is the boundary.
//
// yolo mode BYPASSES the sandbox. We do NOT hide this — the tool result is
// visibly prefixed "[sandbox: BYPASSED]" and the bypass is recorded in the
// audit log. The only way to run bash without a sandbox on macOS is to opt in.

const bashSchema = z.object({
  command: z.string().describe('The bash command to run'),
  network: z.boolean().optional().describe(
    'Opt in to network access. Defaults to false — by default bash runs inside a sandbox that blocks ' +
    'outbound network. Set true for commands that need to reach the internet (curl, npm install, etc). ' +
    'On ask mode, this surfaces a "[network]" prefix in the permission prompt.',
  ),
})

export type ShellSelection =
  | { cmd: string; buildArgs: (command: string) => string[] }
  | { error: string }

export function selectShell(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ShellSelection {
  const override = env.KC_SHELL?.toLowerCase()
  if (platform === 'win32') {
    const shell = override ?? 'cmd'
    if (shell === 'cmd') return { cmd: 'cmd', buildArgs: (c) => ['/c', c] }
    if (shell === 'powershell' || shell === 'pwsh')
      return { cmd: shell, buildArgs: (c) => ['-Command', c] }
    return {
      error:
        `Unsupported shell '${shell}' on Windows. Set KC_SHELL=cmd or KC_SHELL=powershell, ` +
        `or run Telemachus under WSL for full bash support.`,
    }
  }
  // Unix-like: honor KC_SHELL override, default to bash
  const shell = override ?? 'bash'
  return { cmd: shell, buildArgs: (c) => ['-c', c] }
}

/**
 * Pure function — decides the spawn args and sandbox status for a bash invocation.
 * Extracted for testability: no side effects, no Bun.spawn, no network.
 *
 * Decision matrix:
 *   darwin + sandbox available + yolo  → bypass (run unwrapped), sandboxStatus='bypassed'
 *   darwin + sandbox available + ask   → enforce (run via sandbox-exec), sandboxStatus='enforced'
 *   darwin + sandbox UNAVAILABLE + yolo → run unwrapped, sandboxStatus='unavailable', failClosed=false
 *   darwin + sandbox UNAVAILABLE + ask  → fail closed, sandboxStatus='unavailable', failClosed=true
 *   non-darwin (any mode)               → run unwrapped, sandboxStatus='n/a', failClosed=false
 */
export function buildBashInvocation(
  command: string,
  network: boolean,
  context: ToolContext,
): { args: string[]; sandboxStatus: SandboxStatus; failClosed: boolean } {
  const sel = selectShell(process.platform, process.env)
  if ('error' in sel) {
    // Propagate shell error by returning failClosed with a dummy status.
    // The caller checks for shell error before calling this function, so this
    // path is defensive only.
    return { args: [], sandboxStatus: 'n/a', failClosed: false }
  }

  const isYolo = context.mode === 'yolo'
  const shellArgs = sel.buildArgs(command)

  if (process.platform !== 'darwin') {
    // Non-darwin: no sandbox, always run unwrapped. SEC-05 warning fires once at startup.
    return { args: [sel.cmd, ...shellArgs], sandboxStatus: 'n/a', failClosed: false }
  }

  // darwin path
  const sandboxUnavailable = context.sandboxAvailable === false

  if (sandboxUnavailable) {
    if (isYolo) {
      // Run anyway in yolo — caller will prefix "[sandbox: UNAVAILABLE]"
      return { args: [sel.cmd, ...shellArgs], sandboxStatus: 'unavailable', failClosed: false }
    }
    // Non-yolo + no sandbox-exec: fail closed. Caller returns an error result.
    return { args: [], sandboxStatus: 'unavailable', failClosed: true }
  }

  // Sandbox is available on darwin
  if (isYolo) {
    // Explicitly bypass — caller will prefix "[sandbox: BYPASSED]"
    return { args: [sel.cmd, ...shellArgs], sandboxStatus: 'bypassed', failClosed: false }
  }

  // ask / readonly / plan modes: wrap with sandbox-exec
  const sandbox = getPlatformSandbox()
  const wrappedArgs = sandbox.wrap(sel.cmd, shellArgs, {
    network,
    cwd: context.cwd,
    tmpdir: context.sessionTmpdir ?? '/tmp',
  })
  return { args: wrappedArgs, sandboxStatus: 'enforced', failClosed: false }
}

export type BashToolResult = ToolResult & { __sandboxStatus?: SandboxStatus }

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command in the current working directory. Commands are run with a 30s timeout. ' +
    'Stdout and stderr are combined in the result. Exit code is included if non-zero.',
  inputSchema: bashSchema,

  async execute(args: unknown, context: ToolContext): Promise<BashToolResult> {
    const parsed = bashSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { command, network = false } = parsed.data
    const timeoutMs = context.toolTimeoutMs

    const sel = selectShell(process.platform, process.env)
    if ('error' in sel) {
      return { content: sel.error, isError: true }
    }

    const { args: spawnArgs, sandboxStatus, failClosed } = buildBashInvocation(
      command, network, context,
    )

    if (failClosed) {
      return {
        content:
          `sandbox-exec is not available on this system. Bash is disabled in ${context.mode ?? 'ask'} mode. ` +
          `Re-run with yolo mode to bypass (you will see a [sandbox: UNAVAILABLE] prefix on results).`,
        isError: true,
        __sandboxStatus: 'unavailable',
      }
    }

    let timedOut = false
    let proc: ReturnType<typeof Bun.spawn> | null = null

    try {
      proc = Bun.spawn(spawnArgs, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
        cwd: context.cwd,
        env: {
          ...process.env,
          KC_TMPDIR: context.sessionTmpdir ?? '',
        },
      })

      const timer = setTimeout(() => {
        timedOut = true
        if (proc && proc.pid) {
          try {
            if (process.platform !== 'win32') {
              // Kill the entire process group (negative PID) on unix
              process.kill(-proc.pid, 'SIGTERM')
            } else {
              proc.kill()
            }
          } catch {
            // Process may have already exited
            try {
              proc.kill()
            } catch {
              // Ignore
            }
          }
        }
      }, timeoutMs)

      await proc.exited
      clearTimeout(timer)

      if (timedOut) {
        return {
          content: `Command timed out after ${timeoutMs}ms`,
          isError: true,
          __sandboxStatus: sandboxStatus,
        }
      }

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ])

      const exitCode = proc.exitCode ?? 0
      let combined = stdout
      if (stderr) combined += '\nSTDERR:\n' + stderr
      if (exitCode !== 0) combined += `\nExit code: ${exitCode}`

      let content = truncateResult(combined.trim())

      // Prefix result with sandbox status for yolo bypass visibility
      if (sandboxStatus === 'bypassed') {
        content = '[sandbox: BYPASSED]\n' + content
      } else if (sandboxStatus === 'unavailable') {
        content = '[sandbox: UNAVAILABLE]\n' + content
      }

      return {
        content,
        isError: exitCode !== 0,
        __sandboxStatus: sandboxStatus,
      }
    } catch (err) {
      return {
        content: `Failed to execute command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        __sandboxStatus: sandboxStatus,
      }
    }
  },
}
