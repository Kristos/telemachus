/**
 * Phase 24-02 (AGENT-07): launchctl wrapper + ProcessRunner test seam.
 *
 * Everything that shells out in Phase 24 goes through the `ProcessRunner`
 * interface so unit tests can inject a fake. `realRunner` is the only
 * place in this module that calls `node:child_process.spawn`.
 *
 * All launchctl verbs here are the MODERN forms only:
 *   - `launchctl bootstrap gui/<uid> <plist>`
 *   - `launchctl bootout   gui/<uid>/<label>`
 *   - `launchctl print     gui/<uid>/<label>`
 * Never `load`/`unload`/`list` (deprecated, different semantics).
 *
 * Bootout tolerance (Pitfall 4): treating exit 36 / "Could not find specified
 * service" / "No such process" / "Service not loaded" as success-with-
 * wasLoaded=false is what makes `install` and `uninstall` idempotent.
 */
import { spawn } from 'node:child_process'
import { readFile as fsReadFile } from 'node:fs/promises'

export interface ProcessRunner {
  run(
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

export const realRunner: ProcessRunner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => {
        stdout += d.toString()
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? -1 })
      })
    })
  },
}

// ————————————————————————————————————————————————————————————————————————
// launchctl print parser
// ————————————————————————————————————————————————————————————————————————

export interface LaunchctlPrintInfo {
  loaded: boolean
  running: boolean | null
  nextFire: string | null
}

/**
 * Tolerant line walker for `launchctl print gui/<uid>/<label>` output.
 * Non-zero exit → service isn't loaded, return all-null/false.
 * Zero exit → loaded=true, then best-effort scrape state + next fire.
 */
export function parseLaunchctlPrint(
  stdout: string,
  exitCode: number,
): LaunchctlPrintInfo {
  if (exitCode !== 0) {
    return { loaded: false, running: null, nextFire: null }
  }

  let running: boolean | null = null
  let nextFire: string | null = null

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    const stateMatch = line.match(/^state\s*=\s*(.+)$/)
    if (stateMatch) {
      const val = stateMatch[1]!.trim().toLowerCase()
      if (val === 'running') running = true
      else if (val === 'not running' || val === 'waiting') running = false
      else running = null
      continue
    }
    // "next fire = 2026-04-09 15:00:00 +0200 (in 42m 17s)"
    // Strip parenthesized suffix; keep the absolute timestamp.
    const nextMatch = line.match(/^next fire\s*=\s*(.+?)(?:\s*\(.*\))?$/)
    if (nextMatch) {
      nextFire = nextMatch[1]!.trim()
    }
  }

  return { loaded: true, running, nextFire }
}

// ————————————————————————————————————————————————————————————————————————
// Thin verb wrappers
// ————————————————————————————————————————————————————————————————————————

export async function getUid(runner: ProcessRunner): Promise<string> {
  const { stdout, exitCode, stderr } = await runner.run('id', ['-u'])
  if (exitCode !== 0) {
    throw new Error(`id -u failed (exit ${exitCode}): ${stderr}`)
  }
  return stdout.trim()
}

/**
 * Resolve the `kc` entry point into a ProgramArguments prefix.
 *
 * Returns a string[] suitable for use as the start of launchd's
 * `ProgramArguments` array. Callers append the subcommand (`"agent"`,
 * `"run"`, `<name>`).
 *
 * Resolution strategy:
 * 1. `which kc` → absolute path (follows PATH)
 * 2. `realpath <path>` → resolve symlinks (e.g. `~/.bun/bin/kc` → `src/index.ts`)
 * 3. Read the first line. If it's a `#!` shebang, parse the interpreter and
 *    return `[<absolute interpreter>, <resolved script>]`. Otherwise return
 *    `[<resolved binary>]`.
 *
 * Pitfall 12 (revised): launchd's exec() DOES honor kernel shebang handling,
 * so a shebang file technically works — but ONLY if the interpreter named in
 * the shebang is findable under launchd's stripped PATH. `bun link` creates
 * `~/.bun/bin/kc` as a symlink to `src/index.ts` whose shebang is
 * `#!/usr/bin/env bun`. Under launchd, `/usr/bin/env` works but can only find
 * `bun` if we've set `EnvironmentVariables.PATH` correctly (which we do).
 *
 * Rather than depend on that indirect chain, we resolve the shebang ourselves
 * at install time and bake the absolute interpreter path into the plist.
 * That way launchd never has to do shebang or PATH resolution — the exec
 * target is unambiguous.
 */
export async function whichKc(runner: ProcessRunner): Promise<string[]> {
  const which = await runner.run('which', ['tm'])
  if (which.exitCode !== 0 || which.stdout.trim() === '') {
    throw new Error('tm not found on PATH (install tm globally before running `tm agent install`)')
  }
  const whichPath = which.stdout.trim()
  const real = await runner.run('realpath', [whichPath])
  const resolved =
    real.exitCode === 0 && real.stdout.trim() !== '' ? real.stdout.trim() : whichPath

  // Read first line to detect shebang.
  let head: string
  try {
    head = await fsReadFile(resolved, { encoding: 'utf8', flag: 'r' })
  } catch (err) {
    throw new Error(
      `cannot read resolved kc path ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!head.startsWith('#!')) {
    // Native binary — single-element ProgramArguments prefix.
    return [resolved]
  }

  // Parse shebang: `#!<interp> [arg]`
  const firstLine = head.split('\n', 1)[0]
  const rest = firstLine.slice(2).trim() // drop '#!'
  if (rest === '') {
    throw new Error(`kc at ${resolved} has empty shebang line`)
  }

  // Shebang is conventionally `#!<interp>` with at most one arg (kernel
  // behavior on macOS). Split on first whitespace.
  const wsMatch = rest.match(/^(\S+)(?:\s+(\S.*))?$/)
  if (!wsMatch) {
    throw new Error(`kc at ${resolved} has malformed shebang: ${firstLine}`)
  }
  const interpRaw = wsMatch[1]
  const interpArg = wsMatch[2] // e.g. 'bun' from '#!/usr/bin/env bun'

  // If interpRaw is already absolute, use it directly.
  // If it's `/usr/bin/env`, resolve the NEXT token via `which`.
  let interpAbs: string
  if (interpRaw === '/usr/bin/env' && interpArg) {
    const envWhich = await runner.run('which', [interpArg])
    if (envWhich.exitCode !== 0 || envWhich.stdout.trim() === '') {
      throw new Error(
        `kc shebang uses /usr/bin/env ${interpArg} but ${interpArg} was not found on PATH`,
      )
    }
    // Resolve symlinks so launchd gets the canonical binary.
    const envReal = await runner.run('realpath', [envWhich.stdout.trim()])
    interpAbs =
      envReal.exitCode === 0 && envReal.stdout.trim() !== ''
        ? envReal.stdout.trim()
        : envWhich.stdout.trim()
  } else if (interpRaw.startsWith('/')) {
    interpAbs = interpRaw
  } else {
    throw new Error(
      `kc at ${resolved} has non-absolute shebang interpreter '${interpRaw}'; cannot resolve under launchd`,
    )
  }

  return [interpAbs, resolved]
}

export async function bootstrap(
  runner: ProcessRunner,
  uid: string,
  plistPath: string,
): Promise<void> {
  const res = await runner.run('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  if (res.exitCode !== 0) {
    throw new Error(
      `launchctl bootstrap failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
    )
  }
}

const BOOTOUT_NOT_LOADED_PATTERNS = [
  'could not find specified service',
  'no such process',
  'service not loaded',
]

export async function bootout(
  runner: ProcessRunner,
  uid: string,
  label: string,
): Promise<{ wasLoaded: boolean }> {
  const res = await runner.run('launchctl', ['bootout', `gui/${uid}/${label}`])
  if (res.exitCode === 0) return { wasLoaded: true }
  if (res.exitCode === 36) return { wasLoaded: false }
  const stderrLower = res.stderr.toLowerCase()
  if (BOOTOUT_NOT_LOADED_PATTERNS.some((p) => stderrLower.includes(p))) {
    return { wasLoaded: false }
  }
  throw new Error(
    `launchctl bootout failed (exit ${res.exitCode}): ${res.stderr.trim()}`,
  )
}

export async function print(
  runner: ProcessRunner,
  uid: string,
  label: string,
): Promise<LaunchctlPrintInfo> {
  const res = await runner.run('launchctl', ['print', `gui/${uid}/${label}`])
  return parseLaunchctlPrint(res.stdout, res.exitCode)
}
