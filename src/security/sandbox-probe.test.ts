/**
 * SAND-02 (Phase 62, BACKLOG 999.15): Sandbox startup probe tests.
 *
 * All external reads (env, cwd, homedir, .git existence, audit emission)
 * are injected via opts so tests are deterministic regardless of runner
 * environment. No mock.module, no process.env mutation — spyOn only
 * where direct side-effect spying is needed.
 */
import { describe, it, expect, spyOn, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeSandbox,
  resolveProjectRoot,
  type ProbeOpts,
  type ProbeResult,
} from './sandbox-probe.js'
import type { AuditEntry } from './audit.js'

function baseOpts(over: Partial<ProbeOpts> = {}): ProbeOpts {
  return {
    env: { HOME: '/tmp/h' },
    cwd: () => '/tmp/h/repo',
    readHomedir: () => '/tmp/h',
    checkGitDir: (dir: string) => dir === '/tmp/h/repo',
    emitAudit: () => {},
    ...over,
  }
}

describe('probeSandbox SAND-02 (Phase 62, 999.15)', () => {
  const tmpDirsCreated: string[] = []
  const spies: Array<{ mockRestore(): void }> = []

  afterEach(async () => {
    while (spies.length > 0) spies.pop()?.mockRestore()
    for (const dir of tmpDirsCreated.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe('HOME validation', () => {
    it('fails when HOME is empty string', () => {
      const result = probeSandbox(baseOpts({ env: { HOME: '' }, readHomedir: () => '' }))
      expect(result.pass).toBe(false)
      expect(result.reason).toBeDefined()
      expect(result.reason!.toLowerCase()).toContain('home')
      expect(result.reason!.toLowerCase()).toContain('empty')
    })

    it("fails when HOME is fileroot '/'", () => {
      const result = probeSandbox(baseOpts({ env: { HOME: '/' }, readHomedir: () => '/' }))
      expect(result.pass).toBe(false)
      expect(result.reason).toBeDefined()
      expect(result.reason!.toLowerCase()).toContain('home')
      expect(result.reason).toContain("'/'")
    })
  })

  describe('CWD validation', () => {
    it('fails when cwd is empty', () => {
      const result = probeSandbox(baseOpts({ cwd: () => '' }))
      expect(result.pass).toBe(false)
      expect(result.reason!.toLowerCase()).toContain('cwd')
    })

    it("fails when cwd is fileroot '/'", () => {
      const result = probeSandbox(baseOpts({ cwd: () => '/' }))
      expect(result.pass).toBe(false)
      expect(result.reason!.toLowerCase()).toContain('cwd')
      expect(result.reason).toContain("'/'")
    })
  })

  describe('Project root resolution', () => {
    it('passes on happy path (HOME + cwd under git-detected root)', () => {
      const result = probeSandbox(baseOpts())
      expect(result.pass).toBe(true)
      expect(result.home).toBe('/tmp/h')
      expect(result.cwd).toBe('/tmp/h/repo')
      expect(result.projectRoot).toBe('/tmp/h/repo')
    })

    it('fails when cwd is outside the resolved project root allowlist', () => {
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '/tmp/h', KC_PROJECT_ROOT: '/tmp/h/repo' },
          cwd: () => '/tmp/h/other',
        }),
      )
      expect(result.pass).toBe(false)
      expect(result.reason!.toLowerCase()).toContain('allowlist')
    })

    it('honors KC_PROJECT_ROOT override with cwd under a subdirectory', () => {
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '/tmp/h', KC_PROJECT_ROOT: '/tmp/h/repo' },
          cwd: () => '/tmp/h/repo/sub/nested',
          // checkGitDir should be unused once KC_PROJECT_ROOT is set
          checkGitDir: () => false,
        }),
      )
      expect(result.pass).toBe(true)
      expect(result.projectRoot).toBe('/tmp/h/repo')
    })

    it('falls back to .git walk-up detection when KC_PROJECT_ROOT absent', () => {
      // cwd = /a/b/c, .git only at /a/b → resolved root is /a/b
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '/a' },
          readHomedir: () => '/a',
          cwd: () => '/a/b/c',
          checkGitDir: (dir: string) => dir === '/a/b',
        }),
      )
      expect(result.pass).toBe(true)
      expect(result.projectRoot).toBe('/a/b')
    })

    it('falls back to ~/.telemachus walk-up when no .git found', () => {
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '/tmp/h' },
          readHomedir: () => '/tmp/h',
          cwd: () => '/tmp/h/.telemachus/work',
          // no .git anywhere in the chain
          checkGitDir: () => false,
          // Detect ~/.telemachus presence
          checkTelemachusDir: (dir: string) => dir === '/tmp/h',
        }),
      )
      expect(result.pass).toBe(true)
      // Root is the dir containing .telemachus — i.e. homedir
      expect(result.projectRoot).toBe('/tmp/h')
    })
  })

  describe('Bootstrap mode', () => {
    it('passes with valid HOME+CWD when requireProjectRoot=false and no root resolvable', () => {
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '/tmp/h' },
          readHomedir: () => '/tmp/h',
          cwd: () => '/tmp/anywhere',
          checkGitDir: () => false,
          checkTelemachusDir: () => false,
          requireProjectRoot: false,
        }),
      )
      expect(result.pass).toBe(true)
    })
  })

  describe('Audit emission', () => {
    it('emits a sandbox_probe audit entry on failure', () => {
      const emitted: AuditEntry[] = []
      const result = probeSandbox(
        baseOpts({
          env: { HOME: '' },
          readHomedir: () => '',
          sessionId: 'sess-fail',
          emitAudit: (entry) => emitted.push(entry),
        }),
      )
      expect(result.pass).toBe(false)
      expect(emitted).toHaveLength(1)
      expect(emitted[0]!.kind).toBe('sandbox_probe')
      expect(emitted[0]!.outcome).toBe('fail')
      expect(emitted[0]!.reason).toBeDefined()
      expect(emitted[0]!.home).toBeDefined()
      expect(emitted[0]!.cwd).toBeDefined()
      expect(emitted[0]!.sessionId).toBe('sess-fail')
    })

    it('emits a sandbox_probe audit entry on success', () => {
      const emitted: AuditEntry[] = []
      const result = probeSandbox(
        baseOpts({ sessionId: 'sess-pass', emitAudit: (entry) => emitted.push(entry) }),
      )
      expect(result.pass).toBe(true)
      expect(emitted).toHaveLength(1)
      expect(emitted[0]!.kind).toBe('sandbox_probe')
      expect(emitted[0]!.outcome).toBe('pass')
      expect(emitted[0]!.sessionId).toBe('sess-pass')
    })

    it('survives emitAudit throwing — probe must never crash', () => {
      const result = probeSandbox(
        baseOpts({
          emitAudit: () => {
            throw new Error('audit disk full')
          },
        }),
      )
      expect(result.pass).toBe(true)
    })
  })

  describe('resolveProjectRoot fallback warning', () => {
    it('falls back to homedir with stderr warning when all resolutions fail', () => {
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
      spies.push(stderrSpy)

      const { root, via } = resolveProjectRoot({
        env: {},
        cwd: () => '/nowhere',
        homedir: () => '/tmp/fallback-home',
        checkGitDir: () => false,
        checkTelemachusDir: () => false,
      })

      expect(root).toBe('/tmp/fallback-home')
      expect(via).toBe('home-fallback')
      expect(stderrSpy).toHaveBeenCalled()
      const call = stderrSpy.mock.calls[0]
      expect(String(call?.[0] ?? '')).toContain('sandbox-probe')
    })
  })
})
