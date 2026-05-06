import { describe, it, expect } from 'bun:test'
import { homedir } from 'node:os'
import { buildMcpInvocation } from './invocation.js'
import { buildSandboxArgs } from '../tools/sandbox/macos.js'
import type { PlatformSandbox } from '../tools/sandbox/index.js'
import type { SandboxOptions } from '../tools/sandbox/macos.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A fake darwin sandbox that echoes sandbox-exec prefix with a profile string
 * encoding opts.network so assertions can inspect the trust-tier → network
 * mapping without running real SBPL. Also captures the last SandboxOptions
 * it was called with, so tests can assert on extraPaths once Task 3 wires
 * them into SandboxOptions.
 */
function makeDarwinSandbox(): { sandbox: PlatformSandbox; captured: { opts: SandboxOptions | null } } {
  const captured: { opts: SandboxOptions | null } = { opts: null }
  const sandbox: PlatformSandbox = {
    available: true,
    wrap(shellCmd: string, shellArgs: string[], opts: SandboxOptions): string[] {
      captured.opts = opts
      // Encode network flag and extraPaths (if present via Task 3 extension) into
      // the pseudo-profile string so assertions can read them back without real SBPL
      const extra = (opts as { extraPaths?: string[] }).extraPaths ?? []
      const profile = `<profile:network=${opts.network}:extraPaths=${JSON.stringify(extra)}>`
      return ['sandbox-exec', '-p', profile, shellCmd, ...shellArgs]
    },
    async detect() { return true },
  }
  return { sandbox, captured }
}

/** A noop sandbox that passes through command + args unchanged (linux behaviour). */
const noopSandbox: PlatformSandbox = {
  available: false,
  wrap(shellCmd: string, shellArgs: string[]): string[] {
    return [shellCmd, ...shellArgs]
  },
  async detect() { return false },
}

/** A realpath stub that resolves only a known set of entries. */
function makeRealpath(known: Record<string, string>): (p: string) => string {
  return (p: string): string => {
    if (p in known) return known[p]!
    throw new Error(`ENOENT: no such file or directory, lstat '${p}'`)
  }
}

// Convenience: build a simple cfg
function cfg(
  overrides: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    sandbox?: { paths?: string[]; network?: boolean }
  } = {},
) {
  return {
    command: overrides.command ?? 'node',
    args: overrides.args ?? ['server.js'],
    env: overrides.env,
    cwd: overrides.cwd ?? '/some/cwd',
    sandbox: overrides.sandbox,
  }
}

// ---------------------------------------------------------------------------
// Decision matrix
// ---------------------------------------------------------------------------

describe('buildMcpInvocation — trust-tier × network × platform decision matrix', () => {

  // ── Row 1: dangerous + network=true → network always false ───────────────
  it('tier dangerous + sandbox.network=true → sandbox-exec wrap, network off (D-04)', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { network: true } }),
      resolvedTier: 'dangerous',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 2: dangerous + network=undefined → sandbox-exec, network off ─────
  it('tier dangerous + sandbox.network=undefined → sandbox-exec wrap, network off', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg(),
      resolvedTier: 'dangerous',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 3: risky + network=true → silently ignored, network off ──────────
  it('tier risky + sandbox.network=true → silently ignored, network off (D-04)', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { network: true } }),
      resolvedTier: 'risky',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 4: risky + network=false → network off ───────────────────────────
  it('tier risky + sandbox.network=false → network off', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { network: false } }),
      resolvedTier: 'risky',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 5: safe + network=undefined → defaults to off (D-05) ─────────────
  it('tier safe + sandbox.network=undefined → sandbox-exec wrap, network off (D-05)', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg(),
      resolvedTier: 'safe',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 6: safe + network=false → off ────────────────────────────────────
  it('tier safe + sandbox.network=false → sandbox-exec wrap, network off', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { network: false } }),
      resolvedTier: 'safe',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
  })

  // ── Row 7: safe + network=true → network ON ──────────────────────────────
  it('tier safe + sandbox.network=true → sandbox-exec wrap, network ON (D-05)', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { network: true } }),
      resolvedTier: 'safe',
      platformSandbox: sandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=true')
  })

  // ── Row 8: non-darwin (noop sandbox) → passthrough ───────────────────────
  it('non-darwin noop sandbox → command and args passed through unchanged', () => {
    const result = buildMcpInvocation({
      cfg: cfg({ command: 'npx', args: ['mcp-server'] }),
      resolvedTier: 'dangerous',
      platformSandbox: noopSandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('npx')
    expect(result.args).toEqual(['mcp-server'])
  })

  // ── Row 9: sandbox.paths with valid resolvable path (SBPL injection via Task 3) ──
  // Verifies /tmp → /private/tmp symlink resolution and extraPaths → SBPL wiring.
  it('sandbox.paths=["/tmp/foo"] → realpath resolves to /private/tmp/foo, appears in SBPL (D-08, D-09)', () => {
    const { sandbox, captured } = makeDarwinSandbox()
    buildMcpInvocation({
      cfg: cfg({ sandbox: { paths: ['/tmp/foo'] } }),
      resolvedTier: 'dangerous',
      platformSandbox: sandbox,
      realpath: makeRealpath({
        '/some/cwd': '/some/cwd',
        '/tmp/foo': '/private/tmp/foo',
      }),
    })
    expect(captured.opts).not.toBeNull()
    // Task 3: extraPaths are now wired into SandboxOptions and flow to buildProfile
    expect((captured.opts as { extraPaths?: string[] }).extraPaths).toContain('/private/tmp/foo')
  })

  // ── Row 10: sandbox.paths with unresolvable path → dropped, stderr warned ─
  it('sandbox.paths=["/nonexistent/xyz"] → entry dropped, stderr warning emitted (D-08)', () => {
    const { sandbox } = makeDarwinSandbox()
    const warnings: string[] = []
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { paths: ['/nonexistent/definitely/not/there'] } }),
      resolvedTier: 'dangerous',
      platformSandbox: sandbox,
      stderrWrite: (msg) => warnings.push(msg),
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.command).toBe('sandbox-exec')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('dropped unresolvable entry')
    expect(warnings[0]).toContain('/nonexistent/definitely/not/there')
    // extraPaths empty → no resolved path in the profile (Task 2: resolution gating)
    expect(result.args[1]).toContain('extraPaths=[]')
  })

  // ── Row 11: sandbox.paths with tilde expansion ────────────────────────────
  it('sandbox.paths=["~/.claude"] → ~ expanded to homedir before realpath (D-08)', () => {
    const home = homedir()
    const resolvedPath = `${home}/.claude`
    const { sandbox, captured } = makeDarwinSandbox()
    const warnings: string[] = []
    buildMcpInvocation({
      cfg: cfg({ sandbox: { paths: ['~/.claude'] } }),
      resolvedTier: 'dangerous',
      platformSandbox: sandbox,
      stderrWrite: (msg) => warnings.push(msg),
      realpath: makeRealpath({
        '/some/cwd': '/some/cwd',
        [resolvedPath]: resolvedPath, // ~ expansion must produce exactly this key
      }),
    })
    // Verify ~ expansion worked: no warning, opts populated, path in extraPaths
    expect(warnings).toHaveLength(0)
    expect(captured.opts).not.toBeNull()
    expect((captured.opts as { extraPaths?: string[] }).extraPaths).toContain(resolvedPath)
  })

  // ── Row 12: env passthrough ───────────────────────────────────────────────
  it('cfg.env is returned unchanged in result (env passthrough)', () => {
    const env = { OPENAI_API_KEY: 'sk-test', PORT: '3000' }
    const result = buildMcpInvocation({
      cfg: cfg({ env }),
      resolvedTier: 'safe',
      platformSandbox: noopSandbox,
      realpath: makeRealpath({ '/some/cwd': '/some/cwd' }),
    })
    expect(result.env).toStrictEqual(env)
  })

  // ── Row 13: no sandbox field at all → behaves as empty paths, network off ─
  it('cfg with no sandbox field → behaves as sandbox.paths=[], network off', () => {
    const { sandbox } = makeDarwinSandbox()
    const result = buildMcpInvocation({
      cfg: { command: 'python', args: ['-m', 'server'] },
      resolvedTier: 'safe',
      platformSandbox: sandbox,
      realpath: (p: string) => p, // identity
    })
    expect(result.command).toBe('sandbox-exec')
    expect(result.args[1]).toContain('network=false')
    expect(result.args[1]).toContain('extraPaths=[]')
  })

  // ── Test D (Task 3): extraPaths flow end-to-end into SBPL profile string ──
  // Uses a real darwin sandbox that delegates to actual buildSandboxArgs/buildProfile
  // so we can assert on the literal SBPL string, not the fake-encoded profile.
  it('Test D: cfg.sandbox.paths flows from invocation → SandboxOptions → buildProfile → SBPL (D-09)', () => {
    const realDarwinSandbox: PlatformSandbox = {
      available: true,
      wrap(shellCmd: string, shellArgs: string[], opts: SandboxOptions): string[] {
        return buildSandboxArgs(shellCmd, shellArgs, opts)
      },
      async detect() { return true },
    }
    const result = buildMcpInvocation({
      cfg: cfg({ sandbox: { paths: ['/some/data'] } }),
      resolvedTier: 'dangerous',
      platformSandbox: realDarwinSandbox,
      realpath: makeRealpath({
        '/some/cwd': '/some/cwd',
        '/some/data': '/some/data',
      }),
    })
    // The profile is the -p argument (args[1])
    const profile = result.args[1]!
    expect(profile).toContain('(allow file-write* (subpath "/some/data"))')
    expect(profile).toContain('(allow file-write-create (subpath "/some/data"))')
    expect(profile).toContain('(allow file-write-data (subpath "/some/data"))')
    expect(profile).toContain('(allow file-write-unlink (subpath "/some/data"))')
  })

})
