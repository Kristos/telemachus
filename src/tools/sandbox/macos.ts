import { realpathSync } from 'node:fs'

// NOTE: the sandbox profile is security. sandbox-exec + the SBPL below is what
// actually enforces network denial and scoped filesystem writes. The permission
// prompt in ask mode is UX on top of this — it surfaces the command for review,
// but even if the owner approves, the sandbox still constrains what the subprocess
// can reach. Do not weaken this profile to "make a command work"; add a scoped
// allow rule or use `network: true`, never remove (deny default).
//
// Three pitfalls baked in (see internal research Pitfalls 1-3):
//   1. /tmp is a symlink on macOS — always use realpath (/private/tmp/...)
//   2. file-write* does NOT imply file-write-create/file-write-data on macOS 26
//      in deny-default profiles — must be listed explicitly
//   3. The probe must use /usr/bin/true (/bin/true does not exist on macOS 26)

export interface SandboxOptions {
  network: boolean
  cwd: string
  tmpdir: string
  /**
   * Phase 25 (D-07, D-09): extra read-write paths beyond cwd+tmpdir.
   * Each entry is resolved (~ expanded, realpathSync) before reaching here.
   * Each path gets the same four-rule triplet as cwd/tmpdir:
   *   file-write* + file-write-create + file-write-data + file-write-unlink
   */
  extraPaths?: string[]
}

const BASE_PROFILE = `(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow file-ioctl)
(allow file-read*)
(allow file-write* (subpath (param "CWD")))
(allow file-write-create (subpath (param "CWD")))
(allow file-write-data (subpath (param "CWD")))
(allow file-write-unlink (subpath (param "CWD")))
(allow file-write* (subpath (param "TMPDIR")))
(allow file-write-create (subpath (param "TMPDIR")))
(allow file-write-data (subpath (param "TMPDIR")))
(allow file-write-unlink (subpath (param "TMPDIR")))
(allow file-write* (literal "/dev/null"))
(allow file-write* (literal "/dev/stdout"))
(allow file-write* (literal "/dev/stderr"))
(allow file-write* (literal "/dev/tty"))`

const NETWORK_SUFFIX = `
(allow network-outbound)
(allow network-inbound)`

/**
 * Build the SBPL sandbox profile string.
 * @param opts.network  Whether to include network-outbound/inbound rules.
 * @param opts.extraPaths  Additional read-write paths (Phase 25, D-09). Each
 *   path must already be realpath-resolved. Gets the same four-rule triplet as
 *   cwd/tmpdir: file-write* + file-write-create + file-write-data + file-write-unlink.
 */
export function buildProfile(opts: { network: boolean; extraPaths?: string[] }): string {
  let profile = opts.network ? BASE_PROFILE + NETWORK_SUFFIX : BASE_PROFILE
  for (const p of opts.extraPaths ?? []) {
    profile += `\n(allow file-write* (subpath "${p}"))`
    profile += `\n(allow file-write-create (subpath "${p}"))`
    profile += `\n(allow file-write-data (subpath "${p}"))`
    profile += `\n(allow file-write-unlink (subpath "${p}"))`
  }
  return profile
}

export function buildSandboxArgs(
  shellCmd: string,
  shellArgs: string[],
  opts: SandboxOptions,
): string[] {
  const profile = buildProfile({ network: opts.network, extraPaths: opts.extraPaths })
  // Resolve symlinks so SBPL path rules match what the kernel sees.
  // (pitfall: macOS /tmp -> /private/tmp)
  let realCwd: string
  try {
    realCwd = realpathSync(opts.cwd)
  } catch {
    realCwd = opts.cwd
  }
  return [
    'sandbox-exec',
    '-p', profile,
    '-D', `CWD=${realCwd}`,
    '-D', `TMPDIR=${opts.tmpdir}`,
    shellCmd,
    ...shellArgs,
  ]
}

export async function detectSandboxExec(): Promise<boolean> {
  try {
    // /usr/bin/true is the correct probe binary on macOS 26+.
    // /bin/true does not exist on macOS 26 — using it would give a false negative.
    const proc = Bun.spawn(
      ['sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}
