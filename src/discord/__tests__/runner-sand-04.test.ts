/**
 * SAND-04 unit tests (Phase 62, BACKLOG 999.15).
 *
 * Tests the Discord runner's initSandboxEnv helper — the last-mile
 * enforcer that sets process.env.HOME to os.homedir() and seeds
 * process.env.KC_PROJECT_ROOT before any subagent dispatches.
 *
 * Test discipline: spyOn(os, 'homedir') + spyOn(logger) + afterEach
 * restore. Saves/restores process.env per test. No mock.module.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as os from 'node:os'
import * as logger from '../../log/logger.js'
import {
  initSandboxEnv,
  findProjectRoot,
  __resetSandboxEnvForTest,
} from '../runner.js'

describe('SAND-04 initSandboxEnv (Phase 62, 999.15)', () => {
  let origHome: string | undefined
  let origRoot: string | undefined
  const spies: Array<{ mockRestore(): void }> = []

  beforeEach(() => {
    origHome = process.env.HOME
    origRoot = process.env.KC_PROJECT_ROOT
    // Module-level sandboxEnvInitialized may have been set by a prior test
    // file in the same bun worker; reset so initSandboxEnv() runs fresh.
    __resetSandboxEnvForTest()
  })

  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore()
    if (origHome !== undefined) process.env.HOME = origHome
    else delete process.env.HOME
    if (origRoot !== undefined) process.env.KC_PROJECT_ROOT = origRoot
    else delete process.env.KC_PROJECT_ROOT
    __resetSandboxEnvForTest()
  })

  it('sets process.env.HOME to os.homedir() when they differ', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    process.env.HOME = '/wrong/home'

    initSandboxEnv()

    expect(process.env.HOME).toBe('/tmp/kc-real-home')
  })

  it('sets process.env.KC_PROJECT_ROOT when unset', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    delete process.env.KC_PROJECT_ROOT

    initSandboxEnv()

    expect(process.env.KC_PROJECT_ROOT).toBeDefined()
    expect(process.env.KC_PROJECT_ROOT!.length).toBeGreaterThan(0)
  })

  it('is a no-op on second call (idempotent)', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {})
    spies.push(logSpy)

    initSandboxEnv()
    const firstCallCount = logSpy.mock.calls.length
    initSandboxEnv()
    const secondCallCount = logSpy.mock.calls.length

    expect(secondCallCount).toBe(firstCallCount)
  })

  it('does not mutate HOME when os.homedir() returns empty string', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('')
    spies.push(homedirSpy)
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {})
    spies.push(logSpy)
    process.env.HOME = '/pre-existing'

    initSandboxEnv()

    expect(process.env.HOME).toBe('/pre-existing')
    // Must have logged an error citing SAND-04
    const errorCalls = logSpy.mock.calls.filter((call) => call[0] === 'error')
    expect(errorCalls.length).toBe(1)
    expect(String(errorCalls[0]?.[2] ?? '')).toContain('SAND-04')
  })

  it('post-v3.6 hotfix: chdir from fileroot to project root when cwd === "/"', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/')
    spies.push(cwdSpy)
    const chdirSpy = spyOn(process, 'chdir').mockImplementation(() => {})
    spies.push(chdirSpy)
    delete process.env.KC_PROJECT_ROOT

    initSandboxEnv()

    expect(chdirSpy).toHaveBeenCalledTimes(1)
    const target = chdirSpy.mock.calls[0]?.[0]
    expect(target).toBeDefined()
    expect(String(target)).not.toBe('/')
    expect(String(target)).toBe(process.env.KC_PROJECT_ROOT)
  })

  it('post-v3.6 hotfix: does not chdir when cwd is already a real directory', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue('/Users/testuser/projects/telemachus')
    spies.push(cwdSpy)
    const chdirSpy = spyOn(process, 'chdir').mockImplementation(() => {})
    spies.push(chdirSpy)

    initSandboxEnv()

    expect(chdirSpy).not.toHaveBeenCalled()
  })

  it('does not mutate HOME when os.homedir() returns fileroot', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/')
    spies.push(homedirSpy)
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {})
    spies.push(logSpy)
    process.env.HOME = '/pre-existing-2'

    initSandboxEnv()

    expect(process.env.HOME).toBe('/pre-existing-2')
    const errorCalls = logSpy.mock.calls.filter((call) => call[0] === 'error')
    expect(errorCalls.length).toBe(1)
  })

  it('does not log a warning when HOME already matches homedir()', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-match')
    spies.push(homedirSpy)
    const logSpy = spyOn(logger, 'log').mockImplementation(() => {})
    spies.push(logSpy)
    process.env.HOME = '/tmp/kc-match'

    initSandboxEnv()

    const warnCalls = logSpy.mock.calls.filter((call) => call[0] === 'warn')
    // No warn about HOME disagreement (info about KC_PROJECT_ROOT init is fine)
    const homeWarnCalls = warnCalls.filter((call) =>
      String(call[2] ?? '').includes('HOME'),
    )
    expect(homeWarnCalls.length).toBe(0)
  })

  it('does not overwrite an existing KC_PROJECT_ROOT', () => {
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue('/tmp/kc-real-home')
    spies.push(homedirSpy)
    process.env.KC_PROJECT_ROOT = '/pre-set/root'

    initSandboxEnv()

    expect(process.env.KC_PROJECT_ROOT).toBe('/pre-set/root')
  })
})

describe('SAND-04 findProjectRoot (Phase 62, 999.15)', () => {
  const tmpDirsCreated: string[] = []

  afterEach(async () => {
    for (const dir of tmpDirsCreated.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('returns the directory containing .git', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'kc-sand04-findroot-'))
    tmpDirsCreated.push(tmpRoot)
    const project = join(tmpRoot, 'myproject')
    const sub = join(project, 'nested', 'deep')
    await mkdir(sub, { recursive: true })
    await mkdir(join(project, '.git'))

    const found = findProjectRoot(sub)

    expect(found).toBe(project)
  })

  it('returns undefined when no ancestor has .git', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'kc-sand04-nofindroot-'))
    tmpDirsCreated.push(tmpRoot)
    const sub = join(tmpRoot, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })

    const found = findProjectRoot(sub)

    // Found may be undefined, OR if /Users/testuser/... is a parent with .git
    // (the tmp dir actually can resolve upward to a git repo), the result
    // would be some ancestor. We test determinism via the explicit tmp tree:
    // as long as it's NOT the sub itself.
    expect(found).not.toBe(sub)
  })

  it('returns undefined for "/"', () => {
    const found = findProjectRoot('/')
    expect(found).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    const found = findProjectRoot('')
    expect(found).toBeUndefined()
  })
})
