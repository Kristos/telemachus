/**
 * Phase 72 (TGDEPLOY-01, TGDEPLOY-02): Unit tests for Telegram launchd install/uninstall.
 * Phase 72 (TGDEPLOY-03): token + owner-chat-id NOT embedded in plist; ProgramArguments
 *   references a wrapper script that reads both secrets from macOS Keychain.
 *
 * All tests use a temp directory + a fake ProcessRunner.
 * No real ~/Library/LaunchAgents touched, no real launchctl invoked.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  telegramInstall,
  telegramUninstall,
  renderTelegramPlist,
  defaultLauncherPath,
  type InstallPaths,
} from '../launchd.js'
import type { ProcessRunner } from '../../agent-runner/launchctl.js'

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

const TELEGRAM_LABEL = 'com.telemachus.telegram'

let tmpRoot: string
let paths: InstallPaths
let launcherSource: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-telegram-launchd-test-'))
  const launchAgentsDir = path.join(tmpRoot, 'LaunchAgents')
  const homedir = path.join(tmpRoot, 'home')
  await fs.mkdir(homedir, { recursive: true })

  // Stage a fake launcher source script — telegramInstall copies from here
  // to ${homedir}/.telemachus/scripts/kc-telegram-launcher.sh.
  launcherSource = path.join(tmpRoot, 'scripts', 'kc-telegram-launcher.sh')
  await fs.mkdir(path.dirname(launcherSource), { recursive: true })
  await fs.writeFile(
    launcherSource,
    '#!/bin/bash\nexport TELEGRAM_BOT_TOKEN=stub\nexec tm telegram\n',
    { mode: 0o755 },
  )

  paths = { launchAgentsDir, homedir }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function responsesForInstall(plistPath: string, bootoutExit = 36) {
  return {
    'id -u': { exitCode: 0, stdout: '501\n' },
    [`launchctl bootout gui/501/${TELEGRAM_LABEL}`]: { exitCode: bootoutExit },
    [`launchctl bootstrap gui/501 ${plistPath}`]: { exitCode: 0 },
  }
}

describe('renderTelegramPlist (TGDEPLOY-03: no inline token)', () => {
  test('plist references launcher path in ProgramArguments, not `tm telegram`', () => {
    const launcherPath = '/Users/test/.telemachus/scripts/kc-telegram-launcher.sh'
    const xml = renderTelegramPlist({ launcherPath, homedir: '/Users/test' })

    // ProgramArguments points at the wrapper script
    expect(xml).toContain('<key>ProgramArguments</key>')
    expect(xml).toContain(`<string>${launcherPath}</string>`)
    // The old-style `<string>telegram</string>` subcommand must NOT appear —
    // the wrapper execs `tm telegram` itself.
    expect(xml).not.toContain('<string>telegram</string>')
  })

  test('plist EnvironmentVariables contains PATH but NO token key', () => {
    const launcherPath = '/path/to/launcher.sh'
    const xml = renderTelegramPlist({ launcherPath, homedir: '/Users/test' })
    expect(xml).toContain('<key>PATH</key>')
    // Regression guard: no token-shaped env keys leak back into the plist.
    expect(xml).not.toContain('KC_TELEGRAM_TOKEN')
    expect(xml).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(xml).not.toContain('<key>TELEGRAM_TOKEN</key>')
    // Additional TGDEPLOY-03 regression guard: two-secret model — owner ID must not appear
    expect(xml).not.toContain('TELEGRAM_OWNER_CHAT_ID')
    expect(xml).not.toContain('kc-telegram-owner-id')
    expect(xml).not.toContain('kc-telegram-token')
  })

  test('plist keeps KeepAlive true (TGDEPLOY-01) and log paths', () => {
    const xml = renderTelegramPlist({
      launcherPath: '/path/to/launcher.sh',
      homedir: '/Users/test',
    })
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<true/>')
    expect(xml).toContain('<key>StandardOutPath</key>')
    expect(xml).toContain('<key>StandardErrorPath</key>')
    expect(xml).toContain('/Users/test/.telemachus/logs/telegram-stdout.log')
  })
})

describe('defaultLauncherPath', () => {
  test('returns ~/.telemachus/scripts/kc-telegram-launcher.sh', () => {
    expect(defaultLauncherPath('/Users/test')).toBe(
      '/Users/test/.telemachus/scripts/kc-telegram-launcher.sh',
    )
  })
})

describe('telegramInstall', () => {
  test('install writes plist pointing at launcherPath (no inline token)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    const result = await telegramInstall(runner, paths, { launcherSource })

    expect(result.action).toBe('installed')
    expect(result.label).toBe(TELEGRAM_LABEL)
    expect(result.plistPath).toBe(plistPath)

    const xml = await fs.readFile(plistPath, 'utf8')
    // TGDEPLOY-03: plist contains launcher path, not token
    const launcherPath = defaultLauncherPath(paths.homedir)
    expect(xml).toContain(`<string>${launcherPath}</string>`)
    // No token material of any shape
    expect(xml).not.toContain('KC_TELEGRAM_TOKEN')
    // KeepAlive still true
    expect(xml).toContain('<true/>')
  })

  test('install copies launcher script to ~/.telemachus/scripts and chmods 0755', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await telegramInstall(runner, paths, { launcherSource })

    const installedLauncher = defaultLauncherPath(paths.homedir)
    const stat = await fs.stat(installedLauncher)
    expect(stat.isFile()).toBe(true)
    // chmod 0755 — owner-executable minimum
    expect(stat.mode & 0o755).toBe(0o755)
    // Content should match what we staged
    const content = await fs.readFile(installedLauncher, 'utf8')
    expect(content).toContain('exec tm telegram')
  })

  test('install replaces existing plist (TGDEPLOY-01 idempotent-refresh)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<dummy-old-plist/>\n')

    // Bootout exit 0 = was loaded
    const runner = fakeRunner(responsesForInstall(plistPath, 0))

    const result = await telegramInstall(runner, paths, { launcherSource })

    expect(result.action).toBe('replaced')
    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).not.toContain('<dummy-old-plist/>')
    expect(xml).toContain(TELEGRAM_LABEL)
    expect(xml).toContain('<key>KeepAlive</key>')
  })

  test('install creates logs directory (TGDEPLOY-01)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await telegramInstall(runner, paths, { launcherSource })

    const logsDir = path.join(paths.homedir, '.telemachus', 'logs')
    const stat = await fs.stat(logsDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('install accepts custom launcherPath override', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))
    const customLauncher = path.join(tmpRoot, 'custom-launcher.sh')

    await telegramInstall(runner, paths, {
      launcherSource,
      launcherPath: customLauncher,
    })

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain(`<string>${customLauncher}</string>`)
    // Script copied to the custom location
    expect(await fs.stat(customLauncher).then(() => true).catch(() => false)).toBe(true)
  })

  test('install tolerates missing launcherSource (copy skipped, plist still valid)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    // No launcherSource provided — copy is skipped but plist still written
    await telegramInstall(runner, paths, {})

    const xml = await fs.readFile(plistPath, 'utf8')
    const launcherPath = defaultLauncherPath(paths.homedir)
    expect(xml).toContain(`<string>${launcherPath}</string>`)
  })
})

describe('telegramUninstall', () => {
  test('uninstall removes plist (TGDEPLOY-02)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${TELEGRAM_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await telegramInstall(runner, paths, { launcherSource })
    expect(await fs.stat(plistPath).then(() => true).catch(() => false)).toBe(true)

    const uninstallRunner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${TELEGRAM_LABEL}`]: { exitCode: 0 },
    })
    const result = await telegramUninstall(uninstallRunner, paths)

    expect(result.action).toBe('uninstalled')
    expect(await fs.stat(plistPath).then(() => true).catch(() => false)).toBe(false)
  })

  test('uninstall when not installed returns not installed (TGDEPLOY-02 idempotent)', async () => {
    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${TELEGRAM_LABEL}`]: { exitCode: 36 },
    })

    const result = await telegramUninstall(runner, paths)

    expect(result.action).toBe('not installed')
  })
})
