/**
 * Phase 37-02 (UPDATE-04, UPDATE-05): Unit tests for webhook launchd install/uninstall.
 *
 * All tests use a temp directory + a fake ProcessRunner.
 * No real ~/Library/LaunchAgents touched, no real launchctl invoked.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { webhookInstall, webhookUninstall, type InstallPaths } from './webhook-launchd.js'
import type { ProcessRunner } from '../agent-runner/launchctl.js'

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

const WEBHOOK_LABEL = 'com.telemachus.webhook'

let tmpRoot: string
let paths: InstallPaths
let kcBinary: string

const DEFAULT_OPTS = {
  webhookSecretEnvName: 'KC_WEBHOOK_SECRET',
  webhookSecretValue: 'test-secret-value',
  discordTokenEnvName: 'KC_DISCORD_TOKEN',
  discordTokenValue: 'test-token-value',
  port: 9876,
  repoDir: '/repo/telemachus',
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-webhook-launchd-test-'))
  const launchAgentsDir = path.join(tmpRoot, 'LaunchAgents')
  const homedir = path.join(tmpRoot, 'home')
  await fs.mkdir(homedir, { recursive: true })

  // Create a fake "tm" binary with a shebang so whichKc can read it.
  kcBinary = path.join(tmpRoot, 'tm')
  await fs.writeFile(kcBinary, '#!/usr/bin/env bun\n', { mode: 0o755 })

  // Create a fake bun binary path for the 'which bun' call
  const bunBinary = path.join(tmpRoot, 'bun')
  await fs.writeFile(bunBinary, '#!/bin/sh\n', { mode: 0o755 })

  paths = { launchAgentsDir, homedir }
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function responsesForInstall(plistPath: string, bootoutExit = 36) {
  const bunBinary = path.join(tmpRoot, 'bun')
  return {
    'id -u': { exitCode: 0, stdout: '501\n' },
    'which tm': { exitCode: 0, stdout: `${kcBinary}\n` },
    [`realpath ${kcBinary}`]: { exitCode: 0, stdout: `${kcBinary}\n` },
    'which bun': { exitCode: 0, stdout: `${bunBinary}\n` },
    [`realpath ${bunBinary}`]: { exitCode: 0, stdout: `${bunBinary}\n` },
    [`launchctl bootout gui/501/${WEBHOOK_LABEL}`]: { exitCode: bootoutExit },
    [`launchctl bootstrap gui/501 ${plistPath}`]: { exitCode: 0 },
  }
}

describe('renderWebhookPlist (via webhookInstall)', () => {
  test('plist has Label com.telemachus.webhook', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain(`<string>${WEBHOOK_LABEL}</string>`)
  })

  test('plist ProgramArguments ends with "discord", "webhook", "serve"', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>ProgramArguments</key>')
    expect(xml).toContain('<string>discord</string>')
    expect(xml).toContain('<string>webhook</string>')
    expect(xml).toContain('<string>serve</string>')
    // Verify the ordering: discord comes before webhook comes before serve
    const discordIdx = xml.indexOf('<string>discord</string>')
    const webhookIdx = xml.indexOf('<string>webhook</string>')
    const serveIdx = xml.indexOf('<string>serve</string>')
    expect(discordIdx).toBeLessThan(webhookIdx)
    expect(webhookIdx).toBeLessThan(serveIdx)
  })

  test('plist contains KeepAlive true', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>KeepAlive</key>')
    expect(xml).toContain('<true/>')
  })

  test('plist EnvironmentVariables contains webhook secret env var', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>KC_WEBHOOK_SECRET</key>')
    expect(xml).toContain('<string>test-secret-value</string>')
  })

  test('plist EnvironmentVariables contains discord token env var', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>KC_DISCORD_TOKEN</key>')
    expect(xml).toContain('<string>test-token-value</string>')
  })

  test('plist EnvironmentVariables contains KC_REPO_DIR', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>KC_REPO_DIR</key>')
    expect(xml).toContain('<string>/repo/telemachus</string>')
  })

  test('plist EnvironmentVariables contains KC_WEBHOOK_PORT', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('<key>KC_WEBHOOK_PORT</key>')
    expect(xml).toContain('<string>9876</string>')
  })

  test('plist uses webhook-specific log paths', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).toContain('webhook-stdout.log')
    expect(xml).toContain('webhook-stderr.log')
  })
})

describe('webhookInstall', () => {
  test('install calls bootout then writes plist then bootstrap (idempotent-refresh)', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const callOrder: string[] = []
    const trackingRunner: ProcessRunner = {
      async run(cmd, args) {
        const key = [cmd, ...args].join(' ')
        callOrder.push(key)
        const bunBinary = path.join(tmpRoot, 'bun')
        const responses: Record<string, FakeResponse> = {
          'id -u': { exitCode: 0, stdout: '501\n' },
          'which tm': { exitCode: 0, stdout: `${kcBinary}\n` },
          [`realpath ${kcBinary}`]: { exitCode: 0, stdout: `${kcBinary}\n` },
          'which bun': { exitCode: 0, stdout: `${bunBinary}\n` },
          [`realpath ${bunBinary}`]: { exitCode: 0, stdout: `${bunBinary}\n` },
          [`launchctl bootout gui/501/${WEBHOOK_LABEL}`]: { exitCode: 36 },
          [`launchctl bootstrap gui/501 ${plistPath}`]: { exitCode: 0 },
        }
        const r = responses[key]
        if (!r) throw new Error(`unexpected runner call: ${key}`)
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode }
      },
    }

    const result = await webhookInstall(trackingRunner, paths, DEFAULT_OPTS)

    expect(result.action).toBe('installed')
    expect(result.label).toBe(WEBHOOK_LABEL)
    expect(result.plistPath).toBe(plistPath)

    // bootout must come before bootstrap
    const bootoutIdx = callOrder.findIndex(k => k.includes('bootout'))
    const bootstrapIdx = callOrder.findIndex(k => k.includes('bootstrap'))
    expect(bootoutIdx).toBeGreaterThanOrEqual(0)
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0)
    expect(bootoutIdx).toBeLessThan(bootstrapIdx)
  })

  test('install when plist exists returns action replaced', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    await fs.mkdir(paths.launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, '<dummy-old-plist/>\n')

    // bootout exit 0 = was loaded
    const runner = fakeRunner(responsesForInstall(plistPath, 0))

    const result = await webhookInstall(runner, paths, DEFAULT_OPTS)

    expect(result.action).toBe('replaced')
    const xml = await fs.readFile(plistPath, 'utf8')
    expect(xml).not.toContain('<dummy-old-plist/>')
    expect(xml).toContain(WEBHOOK_LABEL)
  })

  test('install creates logs directory', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const runner = fakeRunner(responsesForInstall(plistPath))

    await webhookInstall(runner, paths, DEFAULT_OPTS)

    const logsDir = path.join(paths.homedir, '.telemachus', 'logs')
    const stat = await fs.stat(logsDir)
    expect(stat.isDirectory()).toBe(true)
  })
})

describe('webhookUninstall', () => {
  test('uninstall on non-existent plist returns not installed', async () => {
    const runner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${WEBHOOK_LABEL}`]: { exitCode: 36 },
    })

    const result = await webhookUninstall(runner, paths)

    expect(result.action).toBe('not installed')
  })

  test('uninstall on existing plist calls bootout, deletes file, returns uninstalled', async () => {
    const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
    const installRunner = fakeRunner(responsesForInstall(plistPath))
    await webhookInstall(installRunner, paths, DEFAULT_OPTS)

    // Verify plist was created
    expect(await fs.stat(plistPath).then(() => true).catch(() => false)).toBe(true)

    const uninstallRunner = fakeRunner({
      'id -u': { exitCode: 0, stdout: '501\n' },
      [`launchctl bootout gui/501/${WEBHOOK_LABEL}`]: { exitCode: 0 },
    })
    const result = await webhookUninstall(uninstallRunner, paths)

    expect(result.action).toBe('uninstalled')
    // Plist file must be gone
    expect(await fs.stat(plistPath).then(() => true).catch(() => false)).toBe(false)
  })
})
