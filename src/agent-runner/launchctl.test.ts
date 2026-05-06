/**
 * Phase 24-02 (AGENT-07): launchctl wrapper unit tests.
 *
 * All subprocess activity is faked via `ProcessRunner` injection. These tests
 * never touch real launchd state.
 */
import { describe, test, expect } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseLaunchctlPrint,
  bootout,
  bootstrap,
  whichKc,
  getUid,
  type ProcessRunner,
} from './launchctl'

type FakeResponse = { stdout?: string; stderr?: string; exitCode: number }

function fakeRunner(
  responses: Record<string, FakeResponse>,
): ProcessRunner {
  return {
    async run(cmd, args) {
      const key = [cmd, ...args].join(' ')
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

describe('parseLaunchctlPrint', () => {
  test('non-zero exit → all null/false', () => {
    expect(parseLaunchctlPrint('', 1)).toEqual({
      loaded: false,
      running: null,
      nextFire: null,
    })
  })

  test('state=running + next fire with parenthesized suffix', () => {
    const stdout = `
com.telemachus.agent.demo = {
    state = running
    next fire = 2026-04-09 15:00:00 +0200 (in 42m 17s)
}
`
    const info = parseLaunchctlPrint(stdout, 0)
    expect(info.loaded).toBe(true)
    expect(info.running).toBe(true)
    expect(info.nextFire).toBe('2026-04-09 15:00:00 +0200')
  })

  test('state=not running', () => {
    const info = parseLaunchctlPrint('state = not running\n', 0)
    expect(info.loaded).toBe(true)
    expect(info.running).toBe(false)
  })

  test('exit 0 with no state or next fire → loaded=true, others null', () => {
    const info = parseLaunchctlPrint('some = other\nunrelated = fields\n', 0)
    expect(info).toEqual({ loaded: true, running: null, nextFire: null })
  })

  test('indented lines still parse', () => {
    const stdout = '            state = running\n            next fire = 2026-04-09 15:00:00\n'
    const info = parseLaunchctlPrint(stdout, 0)
    expect(info.running).toBe(true)
    expect(info.nextFire).toBe('2026-04-09 15:00:00')
  })
})

describe('bootout', () => {
  test('exit 0 → wasLoaded=true', async () => {
    const runner = fakeRunner({
      'launchctl bootout gui/501/com.telemachus.agent.demo': { exitCode: 0 },
    })
    expect(await bootout(runner, '501', 'com.telemachus.agent.demo')).toEqual({
      wasLoaded: true,
    })
  })

  test('exit 36 → wasLoaded=false', async () => {
    const runner = fakeRunner({
      'launchctl bootout gui/501/com.telemachus.agent.demo': { exitCode: 36 },
    })
    expect(await bootout(runner, '501', 'com.telemachus.agent.demo')).toEqual({
      wasLoaded: false,
    })
  })

  test('exit 1 + "Could not find specified service" → wasLoaded=false', async () => {
    const runner = fakeRunner({
      'launchctl bootout gui/501/com.telemachus.agent.demo': {
        exitCode: 1,
        stderr: 'Could not find specified service\n',
      },
    })
    expect(await bootout(runner, '501', 'com.telemachus.agent.demo')).toEqual({
      wasLoaded: false,
    })
  })

  test('exit 1 + "Service not loaded" → wasLoaded=false', async () => {
    const runner = fakeRunner({
      'launchctl bootout gui/501/com.telemachus.agent.demo': {
        exitCode: 1,
        stderr: 'Boot-out failed: 5: Service not loaded\n',
      },
    })
    expect(await bootout(runner, '501', 'com.telemachus.agent.demo')).toEqual({
      wasLoaded: false,
    })
  })

  test('exit 5 with unrelated stderr → throws with stderr', async () => {
    const runner = fakeRunner({
      'launchctl bootout gui/501/com.telemachus.agent.demo': {
        exitCode: 5,
        stderr: 'Input/output error',
      },
    })
    await expect(
      bootout(runner, '501', 'com.telemachus.agent.demo'),
    ).rejects.toThrow(/Input\/output error/)
  })
})

describe('bootstrap', () => {
  test('exit 0 → resolves', async () => {
    const runner = fakeRunner({
      'launchctl bootstrap gui/501 /tmp/demo.plist': { exitCode: 0 },
    })
    await bootstrap(runner, '501', '/tmp/demo.plist')
  })

  test('exit 5 with stderr → throws with stderr in message', async () => {
    const runner = fakeRunner({
      'launchctl bootstrap gui/501 /tmp/demo.plist': {
        exitCode: 5,
        stderr: 'permission denied',
      },
    })
    await expect(bootstrap(runner, '501', '/tmp/demo.plist')).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('getUid', () => {
  test('parses stdout, trims newline', async () => {
    const runner = fakeRunner({ 'id -u': { exitCode: 0, stdout: '501\n' } })
    expect(await getUid(runner)).toBe('501')
  })

  test('throws on non-zero exit', async () => {
    const runner = fakeRunner({ 'id -u': { exitCode: 1, stderr: 'oops' } })
    await expect(getUid(runner)).rejects.toThrow(/id -u failed/)
  })
})

describe('whichKc', () => {
  test('returns single-element prefix for a native binary (no shebang)', async () => {
    // /usr/bin/true is a real ELF/Mach-O binary — no '#!' header.
    const runner = fakeRunner({
      'which tm': { exitCode: 0, stdout: '/usr/bin/true\n' },
      'realpath /usr/bin/true': { exitCode: 0, stdout: '/usr/bin/true\n' },
    })
    expect(await whichKc(runner)).toEqual(['/usr/bin/true'])
  })

  test('throws when which returns non-zero', async () => {
    const runner = fakeRunner({ 'which tm': { exitCode: 1 } })
    await expect(whichKc(runner)).rejects.toThrow(/tm not found on PATH/)
  })

  test('resolves `#!/usr/bin/env bun` shebang into [bunAbsPath, script]', async () => {
    // Simulate `bun link` style: `~/.bun/bin/kc` resolves to a .ts entry with
    // `#!/usr/bin/env bun`. Expected result is [resolved-bun, resolved-script].
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-whichkc-'))
    const scriptPath = path.join(tmpDir, 'index.ts')
    await fs.writeFile(scriptPath, '#!/usr/bin/env bun\nconsole.log("kc")\n')
    const fakeBunPath = '/opt/test/bun'
    const runner = fakeRunner({
      'which tm': { exitCode: 0, stdout: `${scriptPath}\n` },
      [`realpath ${scriptPath}`]: { exitCode: 0, stdout: `${scriptPath}\n` },
      'which bun': { exitCode: 0, stdout: `${fakeBunPath}\n` },
      [`realpath ${fakeBunPath}`]: { exitCode: 0, stdout: `${fakeBunPath}\n` },
    })
    expect(await whichKc(runner)).toEqual([fakeBunPath, scriptPath])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('resolves absolute-path shebang (`#!/usr/local/bin/node`) directly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-whichkc-'))
    const scriptPath = path.join(tmpDir, 'kc-node')
    await fs.writeFile(scriptPath, '#!/usr/local/bin/node\nconsole.log("kc")\n')
    const runner = fakeRunner({
      'which tm': { exitCode: 0, stdout: `${scriptPath}\n` },
      [`realpath ${scriptPath}`]: { exitCode: 0, stdout: `${scriptPath}\n` },
    })
    expect(await whichKc(runner)).toEqual(['/usr/local/bin/node', scriptPath])
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('throws when /usr/bin/env interpreter is not on PATH', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-whichkc-'))
    const scriptPath = path.join(tmpDir, 'kc-missing')
    await fs.writeFile(scriptPath, '#!/usr/bin/env nosuchinterp\n')
    const runner = fakeRunner({
      'which tm': { exitCode: 0, stdout: `${scriptPath}\n` },
      [`realpath ${scriptPath}`]: { exitCode: 0, stdout: `${scriptPath}\n` },
      'which nosuchinterp': { exitCode: 1 },
    })
    await expect(whichKc(runner)).rejects.toThrow(
      /shebang uses \/usr\/bin\/env nosuchinterp but nosuchinterp was not found on PATH/,
    )
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('throws on non-absolute non-env shebang interpreter', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-whichkc-'))
    const scriptPath = path.join(tmpDir, 'kc-bad')
    await fs.writeFile(scriptPath, '#!bun\n')
    const runner = fakeRunner({
      'which tm': { exitCode: 0, stdout: `${scriptPath}\n` },
      [`realpath ${scriptPath}`]: { exitCode: 0, stdout: `${scriptPath}\n` },
    })
    await expect(whichKc(runner)).rejects.toThrow(
      /non-absolute shebang interpreter/,
    )
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
