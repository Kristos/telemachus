/**
 * Phase 37-02 (UPDATE-04, UPDATE-05): Webhook service launchd install/uninstall.
 *
 * Manages the com.telemachus.webhook launchd service — the GitHub webhook
 * HTTP listener that auto-updates the codebase on push to main.
 *
 * Design mirrors src/discord/launchd.ts exactly:
 *   - `webhookInstall` is always idempotent-refresh: bootout first, write
 *     plist, bootstrap — regardless of prior state.
 *   - `webhookUninstall` tolerates not-loaded as success (UPDATE-05 idempotent).
 *   - All env var values are baked into the plist at install time.
 *   - All paths are injected via `InstallPaths` so tests use temp dirs.
 *
 * The webhook service runs independently from the Discord bot:
 *   - Different label: com.telemachus.webhook vs com.telemachus.discord
 *   - Different log files: webhook-stdout.log / webhook-stderr.log
 *   - Bot restarts do NOT stop the webhook listener (UPDATE-04)
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { bootout, bootstrap, getUid, whichKc, type ProcessRunner } from '../agent-runner/launchctl.js'
import type { InstallPaths, InstallResult } from '../agent-runner/launchd-install.js'

export type { InstallPaths, InstallResult }

const WEBHOOK_LABEL = 'com.telemachus.webhook'

// ————————————————————————————————————————————————————————————————————————
// Pure plist renderer for webhook service (KeepAlive, not StartCalendarInterval)
// ————————————————————————————————————————————————————————————————————————

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

interface RenderWebhookPlistInput {
  kcPrefix: string[]
  homedir: string
  /** Env var name for the webhook HMAC secret (e.g. KC_WEBHOOK_SECRET) */
  webhookSecretEnvName: string
  /** Actual webhook secret value to bake in */
  webhookSecretValue: string
  /** Env var name for the Discord bot token (for DM-on-failure) */
  discordTokenEnvName: string
  /** Actual Discord token value to bake in */
  discordTokenValue: string
  /** Port to listen on (default 9876) */
  port: number
  /** Absolute path to the repository — baked into KC_REPO_DIR */
  repoDir: string
}

function renderWebhookPlist(input: RenderWebhookPlistInput): string {
  const {
    kcPrefix,
    homedir,
    webhookSecretEnvName,
    webhookSecretValue,
    discordTokenEnvName,
    discordTokenValue,
    port,
    repoDir,
  } = input
  const envPath = `${homedir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  const stdoutLog = `${homedir}/.telemachus/logs/webhook-stdout.log`
  const stderrLog = `${homedir}/.telemachus/logs/webhook-stderr.log`

  const lines: string[] = []
  lines.push(XML_HEADER)
  lines.push('<plist version="1.0">')
  lines.push('<dict>')

  // 1. Label
  lines.push('    <key>Label</key>')
  lines.push(`    <string>${escape(WEBHOOK_LABEL)}</string>`)

  // 2. ProgramArguments: [...kcPrefix, "discord", "webhook", "serve"]
  lines.push('    <key>ProgramArguments</key>')
  lines.push('    <array>')
  for (const arg of kcPrefix) {
    lines.push(`        <string>${escape(arg)}</string>`)
  }
  lines.push('        <string>discord</string>')
  lines.push('        <string>webhook</string>')
  lines.push('        <string>serve</string>')
  lines.push('    </array>')

  // 3. KeepAlive — auto-restart on crash (UPDATE-04)
  lines.push('    <key>KeepAlive</key>')
  lines.push('    <true/>')

  // 4. EnvironmentVariables — PATH + webhook secret + discord token + repo dir + port
  lines.push('    <key>EnvironmentVariables</key>')
  lines.push('    <dict>')
  lines.push('        <key>PATH</key>')
  lines.push(`        <string>${escape(envPath)}</string>`)
  lines.push(`        <key>${escape(webhookSecretEnvName)}</key>`)
  lines.push(`        <string>${escape(webhookSecretValue)}</string>`)
  lines.push(`        <key>${escape(discordTokenEnvName)}</key>`)
  lines.push(`        <string>${escape(discordTokenValue)}</string>`)
  lines.push('        <key>KC_REPO_DIR</key>')
  lines.push(`        <string>${escape(repoDir)}</string>`)
  lines.push('        <key>KC_WEBHOOK_PORT</key>')
  lines.push(`        <string>${escape(String(port))}</string>`)
  lines.push('    </dict>')

  // 5. StandardOutPath
  lines.push('    <key>StandardOutPath</key>')
  lines.push(`    <string>${escape(stdoutLog)}</string>`)

  // 6. StandardErrorPath
  lines.push('    <key>StandardErrorPath</key>')
  lines.push(`    <string>${escape(stderrLog)}</string>`)

  lines.push('</dict>')
  lines.push('</plist>')
  return lines.join('\n') + '\n'
}

// ————————————————————————————————————————————————————————————————————————
// webhookInstall
// ————————————————————————————————————————————————————————————————————————

interface WebhookInstallOpts {
  webhookSecretEnvName: string
  webhookSecretValue: string
  discordTokenEnvName: string
  discordTokenValue: string
  port: number
  repoDir: string
}

export async function webhookInstall(
  runner: ProcessRunner,
  paths: InstallPaths,
  opts: WebhookInstallOpts,
): Promise<InstallResult> {
  const uid = await getUid(runner)
  const kcPrefix = await whichKc(runner)
  const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)

  // Create logs directory before writing plist (UPDATE-04)
  await fs.mkdir(path.join(paths.homedir, '.telemachus', 'logs'), { recursive: true })

  const xml = renderWebhookPlist({
    kcPrefix,
    homedir: paths.homedir,
    webhookSecretEnvName: opts.webhookSecretEnvName,
    webhookSecretValue: opts.webhookSecretValue,
    discordTokenEnvName: opts.discordTokenEnvName,
    discordTokenValue: opts.discordTokenValue,
    port: opts.port,
    repoDir: opts.repoDir,
  })

  await fs.mkdir(paths.launchAgentsDir, { recursive: true })

  const existed = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)
  const action: 'installed' | 'replaced' = existed ? 'replaced' : 'installed'

  // ALWAYS bootout first — idempotent-refresh (ignore wasLoaded)
  await bootout(runner, uid, WEBHOOK_LABEL)

  await fs.writeFile(plistPath, xml, { mode: 0o644 })
  await fs.chmod(plistPath, 0o644)

  await bootstrap(runner, uid, plistPath)

  return { label: WEBHOOK_LABEL, plistPath, action }
}

// ————————————————————————————————————————————————————————————————————————
// webhookUninstall
// ————————————————————————————————————————————————————————————————————————

export async function webhookUninstall(
  runner: ProcessRunner,
  paths: InstallPaths,
): Promise<{ action: 'uninstalled' | 'not installed' }> {
  const plistPath = path.join(paths.launchAgentsDir, `${WEBHOOK_LABEL}.plist`)
  const uid = await getUid(runner)

  const fileExists = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)

  const { wasLoaded } = await bootout(runner, uid, WEBHOOK_LABEL)

  // UPDATE-05: idempotent — not installed is success, not error
  if (!fileExists && !wasLoaded) {
    return { action: 'not installed' }
  }

  await fs.unlink(plistPath).catch(() => {})
  return { action: 'uninstalled' }
}
