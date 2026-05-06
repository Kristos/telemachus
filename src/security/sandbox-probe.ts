/**
 * Phase 62 (SAND-02, BACKLOG 999.15): Sandbox startup probe.
 *
 * Asserts HOME is a non-empty non-fileroot directory AND CWD is under a
 * resolved project-root allowlist before the agent dispatches its first
 * tool. Fails loudly with a structured error on mismatch so operators
 * see the problem instead of silently writing to '/' — the production
 * failure mode documented in BACKLOG 999.14/15.
 *
 * Pure function. All external reads (env, cwd, homedir, .git existence,
 * audit emission) are injectable so tests are deterministic.
 */
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { appendAuditEntry, type AuditEntry, type AuditKind } from './audit.js'

export interface ProbeOpts {
  env?: NodeJS.ProcessEnv
  cwd?: () => string
  readHomedir?: () => string
  checkGitDir?: (dir: string) => boolean
  checkTelemachusDir?: (dir: string) => boolean
  sessionId?: string
  emitAudit?: (entry: AuditEntry) => void
  requireProjectRoot?: boolean
}

export interface ProbeResult {
  pass: boolean
  home: string
  cwd: string
  projectRoot?: string
  reason?: string
}

export interface ResolveRootOpts {
  env?: NodeJS.ProcessEnv
  cwd?: () => string
  homedir?: () => string
  checkGitDir?: (dir: string) => boolean
  checkTelemachusDir?: (dir: string) => boolean
}

export interface ResolveRootResult {
  root: string
  via: 'env' | 'git' | 'telemachus' | 'home-fallback'
}

const SANDBOX_PROBE_KIND: AuditKind = 'sandbox_probe'

function walkUp(start: string, predicate: (dir: string) => boolean): string | undefined {
  let dir = start
  // Safety bound: max 40 levels — deeper CWDs are pathological
  for (let i = 0; i < 40; i++) {
    if (!dir || dir === '/') return undefined
    if (predicate(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export function resolveProjectRoot(opts: ResolveRootOpts = {}): ResolveRootResult {
  const env = opts.env ?? process.env
  const cwdFn = opts.cwd ?? process.cwd
  const homedirFn = opts.homedir ?? osHomedir
  const checkGit = opts.checkGitDir ?? ((dir: string) => existsSync(join(dir, '.git')))
  const checkKc =
    opts.checkTelemachusDir ?? ((dir: string) => existsSync(join(dir, '.telemachus')))

  // Priority 1: KC_PROJECT_ROOT env var
  const envRoot = env.KC_PROJECT_ROOT
  if (envRoot && envRoot.length > 0) {
    return { root: resolve(envRoot), via: 'env' }
  }

  const startCwd = cwdFn()

  // Priority 2: walk up from cwd looking for .git
  if (startCwd && startCwd !== '/') {
    const gitRoot = walkUp(startCwd, checkGit)
    if (gitRoot) return { root: gitRoot, via: 'git' }
  }

  // Priority 3: walk up looking for a dir containing .telemachus
  if (startCwd && startCwd !== '/') {
    const kcRoot = walkUp(startCwd, checkKc)
    if (kcRoot) return { root: kcRoot, via: 'telemachus' }
  }

  // Priority 4: fall back to homedir with a stderr warning
  const home = homedirFn()
  try {
    process.stderr.write(
      `[sandbox-probe] warn: could not resolve project root from cwd='${startCwd}' — defaulting to HOME='${home}'\n`,
    )
  } catch {
    // stderr write is best-effort; swallow failures
  }
  return { root: home, via: 'home-fallback' }
}

function isHomeValid(home: string): { ok: true } | { ok: false; reason: string } {
  if (!home || home.length === 0) {
    return { ok: false, reason: "HOME is empty — homedir() returned '' or undefined" }
  }
  if (home === '/') {
    return { ok: false, reason: "HOME resolves to fileroot '/' — passwd entry returns '/' for this user" }
  }
  if (!isAbsolute(home)) {
    return { ok: false, reason: `HOME is not an absolute path: '${home}'` }
  }
  return { ok: true }
}

function isCwdValid(cwd: string): { ok: true } | { ok: false; reason: string } {
  if (!cwd || cwd.length === 0) {
    return { ok: false, reason: 'cwd is empty' }
  }
  if (cwd === '/') {
    return { ok: false, reason: "cwd resolves to fileroot '/'" }
  }
  return { ok: true }
}

function cwdUnderRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true
  const needle = root.endsWith('/') ? root : `${root}/`
  return cwd.startsWith(needle)
}

function emitSafely(
  emit: ((entry: AuditEntry) => void) | undefined,
  entry: AuditEntry,
): void {
  try {
    if (emit) emit(entry)
    else void appendAuditEntry(entry)
  } catch {
    // audit emission is best-effort — never crash the probe
  }
}

export function probeSandbox(opts: ProbeOpts = {}): ProbeResult {
  const env = opts.env ?? process.env
  const cwdFn = opts.cwd ?? process.cwd
  const homedirFn = opts.readHomedir ?? osHomedir
  const requireProjectRoot = opts.requireProjectRoot ?? true
  const sessionId = opts.sessionId ?? 'sandbox-probe'

  const homeRaw = env.HOME ?? homedirFn()
  const home = homeRaw ?? ''
  const cwd = cwdFn() ?? ''

  const baseAudit = (
    outcome: 'pass' | 'fail',
    reason: string | undefined,
    projectRoot: string | undefined,
  ): AuditEntry => ({
    ts: new Date().toISOString(),
    kind: SANDBOX_PROBE_KIND,
    sessionId,
    platform: process.platform,
    outcome,
    reason,
    home,
    cwd,
    projectRoot,
  })

  // HOME check first — most common failure mode per 999.14
  const homeCheck = isHomeValid(home)
  if (!homeCheck.ok) {
    const result: ProbeResult = {
      pass: false,
      home,
      cwd,
      reason: homeCheck.reason,
    }
    emitSafely(opts.emitAudit, baseAudit('fail', result.reason, undefined))
    return result
  }

  // CWD check
  const cwdCheck = isCwdValid(cwd)
  if (!cwdCheck.ok) {
    const result: ProbeResult = {
      pass: false,
      home,
      cwd,
      reason: cwdCheck.reason,
    }
    emitSafely(opts.emitAudit, baseAudit('fail', result.reason, undefined))
    return result
  }

  // Project root resolution
  const { root, via } = resolveProjectRoot({
    env,
    cwd: cwdFn,
    homedir: homedirFn,
    checkGitDir: opts.checkGitDir,
    checkTelemachusDir: opts.checkTelemachusDir,
  })

  // If we couldn't resolve a real root (home-fallback) AND requireProjectRoot is true,
  // we still pass iff cwd is under the home-fallback root — the probe is about catching
  // silent / writes, not enforcing repo discipline.
  if (!requireProjectRoot) {
    const result: ProbeResult = {
      pass: true,
      home,
      cwd,
      projectRoot: root,
    }
    emitSafely(opts.emitAudit, baseAudit('pass', undefined, root))
    return result
  }

  // Allowlist check: cwd must be at or under the resolved root
  if (!cwdUnderRoot(cwd, root)) {
    const reason = `cwd='${cwd}' is outside the project-root allowlist (root='${root}' via=${via})`
    const result: ProbeResult = {
      pass: false,
      home,
      cwd,
      projectRoot: root,
      reason,
    }
    emitSafely(opts.emitAudit, baseAudit('fail', reason, root))
    return result
  }

  const result: ProbeResult = {
    pass: true,
    home,
    cwd,
    projectRoot: root,
  }
  emitSafely(opts.emitAudit, baseAudit('pass', undefined, root))
  return result
}
