import { describe, test, expect } from 'bun:test'
import { buildProfile, buildSandboxArgs, detectSandboxExec } from './macos.js'

describe('buildProfile', () => {
  test('no-network profile contains deny default and base allows', () => {
    const p = buildProfile({ network: false })
    expect(p).toContain('(version 1)')
    expect(p).toContain('(deny default)')
    expect(p).toContain('(allow file-read*)')
    expect(p).toContain('(allow file-write* (subpath (param "CWD")))')
    expect(p).toContain('(allow file-write-create (subpath (param "CWD")))')
    expect(p).toContain('(allow file-write-data (subpath (param "CWD")))')
    expect(p).toContain('(allow file-write* (subpath (param "TMPDIR")))')
    expect(p).toContain('(allow file-write-create (subpath (param "TMPDIR")))')
  })

  test('no-network profile does not allow network', () => {
    const p = buildProfile({ network: false })
    expect(p).not.toContain('network-outbound')
    expect(p).not.toContain('network-inbound')
  })

  test('network profile allows outbound and inbound', () => {
    const p = buildProfile({ network: true })
    expect(p).toContain('(allow network-outbound)')
    expect(p).toContain('(allow network-inbound)')
    // still has deny default + base allows
    expect(p).toContain('(deny default)')
    expect(p).toContain('(allow file-read*)')
  })

  // ── Test A (Phase 25, D-09): extraPaths injects full four-rule triplet ───
  test('extraPaths: each entry gets file-write* + file-write-create + file-write-data + file-write-unlink', () => {
    const p = buildProfile({ network: false, extraPaths: ['/Users/test/data'] })
    expect(p).toContain('(allow file-write* (subpath "/Users/test/data"))')
    expect(p).toContain('(allow file-write-create (subpath "/Users/test/data"))')
    expect(p).toContain('(allow file-write-data (subpath "/Users/test/data"))')
    expect(p).toContain('(allow file-write-unlink (subpath "/Users/test/data"))')
  })

  // ── Test B: extraPaths=[] produces same profile as before (no regression) ─
  test('extraPaths=[] produces same profile as without extraPaths', () => {
    const withEmpty = buildProfile({ network: false, extraPaths: [] })
    const withoutField = buildProfile({ network: false })
    expect(withEmpty).toBe(withoutField)
  })

  // ── Test B2: extraPaths=undefined also produces same base profile ─────────
  test('extraPaths=undefined produces base profile unchanged', () => {
    const withUndef = buildProfile({ network: false, extraPaths: undefined })
    const base = buildProfile({ network: false })
    expect(withUndef).toBe(base)
  })

  // ── Multiple extra paths ──────────────────────────────────────────────────
  test('multiple extraPaths each get the four-rule set', () => {
    const p = buildProfile({ network: false, extraPaths: ['/path/one', '/path/two'] })
    expect(p).toContain('(allow file-write-unlink (subpath "/path/one"))')
    expect(p).toContain('(allow file-write-unlink (subpath "/path/two"))')
  })
})

describe('buildSandboxArgs', () => {
  test('wraps shell command with sandbox-exec and CWD/TMPDIR params', () => {
    const args = buildSandboxArgs('bash', ['-c', 'ls'], {
      network: false,
      cwd: process.cwd(),
      tmpdir: '/private/tmp/kc-test',
    })
    expect(args[0]).toBe('sandbox-exec')
    expect(args[1]).toBe('-p')
    expect(args[2]).toContain('(deny default)')
    expect(args[3]).toBe('-D')
    expect(args[4]!.startsWith('CWD=')).toBe(true)
    expect(args[5]).toBe('-D')
    expect(args[6]).toBe('TMPDIR=/private/tmp/kc-test')
    expect(args[7]).toBe('bash')
    expect(args[8]).toBe('-c')
    expect(args[9]).toBe('ls')
  })

  test('network=true injects network rules in the profile arg', () => {
    const args = buildSandboxArgs('bash', ['-c', 'curl x'], {
      network: true,
      cwd: process.cwd(),
      tmpdir: '/private/tmp/kc-test',
    })
    expect(args[2]).toContain('network-outbound')
  })

  // ── Test C (Phase 25, D-09): extraPaths in SandboxOptions flows into profile
  test('extraPaths in SandboxOptions appear in the -p profile arg', () => {
    const args = buildSandboxArgs('node', ['server.js'], {
      network: false,
      cwd: process.cwd(),
      tmpdir: '/private/tmp/kc-test',
      extraPaths: ['/Users/test/data'],
    })
    const profile = args[2]!
    expect(profile).toContain('(allow file-write* (subpath "/Users/test/data"))')
    expect(profile).toContain('(allow file-write-create (subpath "/Users/test/data"))')
    expect(profile).toContain('(allow file-write-data (subpath "/Users/test/data"))')
    expect(profile).toContain('(allow file-write-unlink (subpath "/Users/test/data"))')
  })

  test('extraPaths=undefined produces same profile as without extraPaths (no regression)', () => {
    const withUndef = buildSandboxArgs('bash', [], {
      network: false,
      cwd: '/some/cwd',
      tmpdir: '/tmp',
      extraPaths: undefined,
    })
    const without = buildSandboxArgs('bash', [], {
      network: false,
      cwd: '/some/cwd',
      tmpdir: '/tmp',
    })
    // Same profile string (args[2])
    expect(withUndef[2]).toBe(without[2])
  })
})

describe('detectSandboxExec', () => {
  test('returns a boolean (true on macOS, false elsewhere)', async () => {
    const result = await detectSandboxExec()
    expect(typeof result).toBe('boolean')
    if (process.platform === 'darwin') {
      expect(result).toBe(true)
    }
  })
})
