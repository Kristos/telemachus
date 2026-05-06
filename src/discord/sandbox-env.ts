/**
 * Phase 65 (HYG-01): Extracted from runner.ts — SAND-04 HOME/CWD wiring.
 *
 * launchd plist ProgramArguments inherits env from launchctl context, which
 * under some conditions strips HOME — the root-cause hypothesis for the 17
 * production write_todos EROFS failures. initSandboxEnv is the last-mile
 * enforcer: explicit process.env.HOME = os.homedir() + seeded KC_PROJECT_ROOT
 * before any subagent dispatches.
 *
 * Idempotent — first Discord message call wins; subsequent calls are no-ops.
 * Never throws — catastrophic os.homedir() returns log an error and leave
 * env untouched; the SAND-02 probe downstream catches and aborts the turn.
 */
import * as os from 'node:os'
const homedir = (): string => os.homedir()
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../log/logger.js'

let sandboxEnvInitialized = false

/**
 * Walk up from startDir looking for a directory containing `.git`.
 * Returns undefined if none found before reaching filesystem root.
 * Safety-bounded at 40 levels.
 *
 * Exported for SAND-04 unit tests. Follow-up: replace with
 * `resolveProjectRoot` from src/security/sandbox-probe.ts once
 * 62-02 has stabilized (same logic, unified call site).
 */
export function findProjectRoot(startDir: string): string | undefined {
  if (!startDir || startDir === '/') return undefined
  let dir = startDir
  for (let i = 0; i < 40; i++) {
    if (!dir || dir === '/') return undefined
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Test-only: reset the one-shot init flag so each test starts fresh. */
export function __resetSandboxEnvForTest(): void {
  sandboxEnvInitialized = false
}

/**
 * Explicit HOME + KC_PROJECT_ROOT wiring for Discord subagents.
 * Exported for SAND-04 unit tests — otherwise module-internal.
 */
export function initSandboxEnv(): void {
  if (sandboxEnvInitialized) return
  sandboxEnvInitialized = true

  const realHome = homedir()
  const envHome = process.env.HOME

  if (!realHome || realHome === '/') {
    // Catastrophic — os.homedir() can't help us. Log and bail; the
    // SAND-02 probe downstream will fail the turn with a cleaner message.
    log(
      'error',
      { realHome, envHome },
      'SAND-04: os.homedir() returned bad value — cannot repair HOME env',
    )
    return
  }

  if (envHome !== realHome) {
    log(
      'warn',
      { envHome, realHome },
      'SAND-04: process.env.HOME disagrees with os.homedir() — setting to os.homedir()',
    )
    process.env.HOME = realHome
  }

  if (!process.env.KC_PROJECT_ROOT) {
    // Priority 1: walk up from process.cwd() looking for .git
    let via: 'git-from-cwd' | 'git-from-module' | 'home-fallback' = 'home-fallback'
    let root: string | undefined = findProjectRoot(process.cwd())
    if (root) via = 'git-from-cwd'

    // Priority 2 (post-v3.6 hotfix): when cwd is '/' launchd strands us at
    // fileroot. import.meta.dir points inside the running repo — walk up from
    // there to find .git reliably. Only consulted when cwd-based walk fails.
    if (!root) {
      const moduleRoot = findProjectRoot(import.meta.dir)
      if (moduleRoot) {
        root = moduleRoot
        via = 'git-from-module'
      }
    }

    // Priority 3: fall back to realHome (existing behavior — permits probe
    // to pass, but subagents run at HOME instead of repo root).
    if (!root) root = realHome

    process.env.KC_PROJECT_ROOT = root
    log('info', { projectRoot: root, via }, 'SAND-04: KC_PROJECT_ROOT initialized')
  }

  // Post-v3.6 hotfix: launchd spawns Discord with process.cwd() === '/'.
  // SAND-02 probe downstream rejects fileroot cwd. Chdir to the resolved
  // project root so the probe sees a real directory. Silent on failure —
  // the probe will still catch and abort cleanly if the chdir cannot land.
  const targetCwd = process.env.KC_PROJECT_ROOT
  if (targetCwd && process.cwd() === '/') {
    try {
      process.chdir(targetCwd)
      log('info', { cwd: targetCwd }, 'SAND-04: chdir from fileroot to project root')
    } catch (err) {
      log(
        'error',
        { targetCwd, err: err instanceof Error ? err.message : String(err) },
        'SAND-04: failed to chdir to project root',
      )
    }
  }
}
