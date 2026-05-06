/**
 * Phase 24-02 (AGENT-07): launchd-install orchestrator unit tests.
 *
 * All tests use a temp LaunchAgents dir + a fake ProcessRunner. No real
 * ~/Library/LaunchAgents touched, no real launchctl invoked.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  install,
  uninstall,
  list,
  formatListTable,
  type InstallPaths,
} from './launchd-install'
import type { ProcessRunner } from './launchctl'
import type { AgentJobConfig } from './config-schema'
import type { KristosConfig } from '../config/types'

type FakeResponse = { stdout?: string; stderr?: string; exitCode: number }

function fakeRunner(
  responses: Record<string, FakeResponse>,
  calls?: string[],
): ProcessRunner {
  return {
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ')
      calls?.push(key)
      const r = responses[key]
      if (!r) throw new Error(`unexpected runner call: ${key}`)
      return {
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        exitCode: r.exitCode,
      }
    },
  }
}

let tmpRoot: string
let paths: InstallPaths
let kcBinary: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-launchd-test-'))
  const launchAgentsDir = path.join(tmpRoot, 'LaunchAgents')
  const homedir = path.join(tmpRoot, 'home')
  await fs.mkdir(homedir, { recursive: true })
  // Create a real (non-shim) "tm" binary via a symlink to /usr/bin/true.
  kcBinary = path.join(tmpRoot, 'tm')
  await fs.symlink('/usr/bin/true', kcBinary)
  paths = { launchAgentsDir, homedir }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function responsesForInstall(label: string, plistPath: string, bootoutExit = 36) {
  return {
    'id -u': { exitCode: 0, stdout: '501\n' },
    'which tm': { exitCode: 0, stdout: `${kcBinary}\n` },
    [`realpath ${kcBinary}`]: { exitCode: 0, stdout: '/usr/bin/true\n' },
    [`launchctl bootout gui/501/${label}`]: { exitCode: bootoutExit },
    [`launchctl bootstrap gui/501 ${plistPath}`]: { exitCode: 0 },
  }
}

describe('install', () => {
  test('fresh install writes plist, bootouts then bootstraps, returns installed', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    const calls: string[] = []
    const runner = fakeRunner(responsesForInstall(label, plistPath), calls)
    const jobCfg: AgentJobConfig = { prompt: 'hi', schedule: 'hourly' }

    const result = await install('demo', jobCfg, runner, paths)

    expect(result).toEqual({ label, plistPath, action: 'installed' })
    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain(label)
    expect(xml).toContain('<integer>0</integer>') // Minute=0 from hourly
    expect(xml).toContain('/usr/bin/true')
    expect(xml).toContain('<string>demo</string>') // job name in argv
    // bootout BEFORE bootstrap
    const bootoutIdx = calls.findIndex((c) => c.startsWith('launchctl bootout'))
    const bootstrapIdx = calls.findIndex((c) => c.startsWith('launchctl bootstrap'))
    expect(bootoutIdx).toBeGreaterThanOrEqual(0)
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx)
  })

  test('install over existing plist returns replaced', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<old/>\n')
    // Existing bootout succeeds (was loaded)
    const runner = fakeRunner(responsesForInstall(label, plistPath, 0))
    const jobCfg: AgentJobConfig = { prompt: 'hi', schedule: 'daily' }

    const result = await install('demo', jobCfg, runner, paths)
    expect(result.action).toBe('replaced')
    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).not.toBe('<old/>\n') // rewritten
    expect(xml).toContain('<key>Hour</key>') // daily → Hour=0 Minute=0
  })

  test('rejects missing schedule', async () => {
    const runner = fakeRunner({})
    const jobCfg: AgentJobConfig = { prompt: 'hi' }
    await expect(install('demo', jobCfg, runner, paths)).rejects.toThrow(
      /no schedule/,
    )
    // No filesystem side effect.
    await expect(
      fs.stat(path.join(paths.launchAgentsDir, 'com.telemachus.agent.demo.plist')),
    ).rejects.toThrow()
  })

  test('propagates parseSchedule error verbatim', async () => {
    const runner = fakeRunner({})
    const jobCfg: AgentJobConfig = { prompt: 'hi', schedule: 'weekly' }
    await expect(install('demo', jobCfg, runner, paths)).rejects.toThrow(
      /Phase 24 schedule only supports/,
    )
  })

  test('creates LaunchAgents dir if missing (Pitfall 10)', async () => {
    // Confirm it doesn't exist yet.
    await expect(fs.stat(paths.launchAgentsDir)).rejects.toThrow()
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    const runner = fakeRunner(responsesForInstall(label, plistPath))
    await install('demo', { prompt: 'x', schedule: 'hourly' }, runner, paths)
    const stat = await fs.stat(paths.launchAgentsDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('writes plist with mode 0644 (Pitfall 11)', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    const runner = fakeRunner(responsesForInstall(label, plistPath))
    await install('demo', { prompt: 'x', schedule: 'hourly' }, runner, paths)
    const stat = await fs.stat(plistPath)
    expect(stat.mode & 0o777).toBe(0o644)
  })
})

describe('uninstall', () => {
  test('loaded + file present → uninstalled, file removed', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<plist/>\n')
    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${label}`]: { exitCode: 0 },
    })
    const res = await uninstall('demo', runner, paths)
    expect(res).toEqual({ action: 'uninstalled' })
    await expect(fs.stat(plistPath)).rejects.toThrow()
  })

  test('not loaded + file absent → not installed, no throw', async () => {
    const label = 'com.telemachus.agent.demo'
    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${label}`]: { exitCode: 36 },
    })
    const res = await uninstall('demo', runner, paths)
    expect(res).toEqual({ action: 'not installed' })
  })

  test('not loaded + file present → removes file, uninstalled', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<plist/>\n')
    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${label}`]: { exitCode: 36 },
    })
    const res = await uninstall('demo', runner, paths)
    expect(res).toEqual({ action: 'uninstalled' })
    await expect(fs.stat(plistPath)).rejects.toThrow()
  })

  test('NEVER touches ~/.telemachus/agent-runs/', async () => {
    const label = 'com.telemachus.agent.demo'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<plist/>\n')
    // Set up agent-runs fixture under the test's homedir
    const agentRuns = path.join(paths.homedir, '.telemachus', 'agent-runs', 'demo', 'latest')
    await fs.mkdir(agentRuns, { recursive: true })
    await fs.writeFile(path.join(agentRuns, 'usage.json'), '{"duration_ms":123}')

    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${label}`]: { exitCode: 0 },
    })
    await uninstall('demo', runner, paths)

    // Fixture intact.
    const usage = await fs.readFile(path.join(agentRuns, 'usage.json'), 'utf8')
    expect(usage).toBe('{"duration_ms":123}')
  })
})

describe('list', () => {
  test('empty config → empty array', async () => {
    const runner = fakeRunner({})
    const rows = await list({ agents: {} } as unknown as KristosConfig, runner, paths)
    expect(rows).toEqual([])
  })

  test('two jobs, one installed + loaded, one not installed', async () => {
    const label = 'com.telemachus.agent.alpha'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<plist/>\n')

    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl print gui/501/${label}`]: {
        exitCode: 0,
        stdout:
          'state = running\nnext fire = 2026-04-09 15:00:00 +0200 (in 42m 17s)\n',
      },
    })

    const config = {
      agents: {
        alpha: { prompt: 'a', schedule: 'hourly' } as AgentJobConfig,
        beta: { prompt: 'b', schedule: 'daily' } as AgentJobConfig,
      },
    } as unknown as KristosConfig

    const rows = await list(config, runner, paths)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.name).toBe('alpha')
    expect(rows[0]!.installed).toBe(true)
    expect(rows[0]!.loaded).toBe(true)
    expect(rows[0]!.nextFire).toBe('2026-04-09 15:00:00 +0200')
    expect(rows[0]!.running).toBe('y')
    expect(rows[1]!.name).toBe('beta')
    expect(rows[1]!.installed).toBe(false)
    expect(rows[1]!.running).toBe('?')

    const table = formatListTable(rows)
    expect(table).toContain('NAME')
    expect(table).toContain('alpha')
    expect(table).toContain('beta')
  })

  test('tolerates launchctl print with no state/next fire — row shows ? fallbacks', async () => {
    const label = 'com.telemachus.agent.alpha'
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<plist/>\n')

    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl print gui/501/${label}`]: {
        exitCode: 0,
        stdout: 'some = unrelated\nfields = only\n',
      },
    })

    const config = {
      agents: { alpha: { prompt: 'a', schedule: 'hourly' } as AgentJobConfig },
    } as unknown as KristosConfig
    const rows = await list(config, runner, paths)
    expect(rows[0]!.loaded).toBe(true)
    expect(rows[0]!.running).toBe('?')
    expect(rows[0]!.nextFire).toBe('?')
  })
})

describe('formatListTable', () => {
  test('empty rows → empty-state message', () => {
    expect(formatListTable([])).toContain('No agent jobs configured')
  })
})
