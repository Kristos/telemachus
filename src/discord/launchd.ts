/**
 * Phase 34-01 (OPS-01, OPS-02): Discord-specific launchd install/uninstall.
 *
 * Distinct from src/agent-runner/launchd-install.ts because the Discord bot
 * uses `KeepAlive` (long-running service, auto-restart on crash) rather than
 * `StartCalendarInterval` (cron-style one-shot jobs).
 *
 * Phase 65 (HYG-04): the plist no longer embeds the Discord bot token inline.
 * ProgramArguments now invokes scripts/kc-discord-launcher.sh which retrieves
 * the token from macOS Keychain (with env-var fallback + stderr warning) and
 * execs `tm discord` with DISCORD_BOT_TOKEN exported. See docs/keychain.md.
 *
 * Design rules:
 *   - `discordInstall` is always idempotent-refresh: bootout first, write
 *     plist, bootstrap — regardless of prior state.
 *   - `discordUninstall` tolerates not-loaded as success (OPS-02 idempotent).
 *   - Launcher script is copied to ~/.telemachus/scripts/ on install so the
 *     plist can reference a stable absolute path; chmod 0o755 for launchd.
 *   - All paths are injected via `InstallPaths` so tests use temp dirs.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { bootout, bootstrap, getUid, type ProcessRunner } from '../agent-runner/launchctl.js'
import type { InstallPaths, InstallResult } from '../agent-runner/launchd-install.js'

export type { InstallPaths, InstallResult }

const DISCORD_LABEL = 'com.telemachus.discord'
/**
 * Default absolute path for the launcher wrapper once it's been copied to
 * the user's ~/.telemachus/scripts/ directory by discordInstall. Separate
 * from the repo-relative source path (scripts/kc-discord-launcher.sh) so the
 * plist can reference a stable location even if the repo is later moved.
 */
export function defaultLauncherPath(homedir: string): string {
  return path.join(homedir, '.telemachus', 'scripts', 'kc-discord-launcher.sh')
}

// ————————————————————————————————————————————————————————————————————————
// Pure plist renderer for Discord (KeepAlive, not StartCalendarInterval)
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

interface RenderDiscordPlistInput {
  /** Absolute path to the launcher wrapper script (kc-discord-launcher.sh)
   *  that retrieves the token from Keychain and execs `tm discord`. */
  launcherPath: string
  homedir: string
  /** Post-v3.6 hotfix: absolute path that launchd should `chdir` into before
   *  running the launcher. Prevents `process.cwd() === '/'` tripping the
   *  SAND-02 sandbox probe on every subagent spawn. Defaults to homedir. */
  workingDirectory?: string
}

export function renderDiscordPlist(input: RenderDiscordPlistInput): string {
  const { launcherPath, homedir } = input
  const workingDir = input.workingDirectory ?? homedir
  const envPath = `${homedir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  const stdoutLog = `${homedir}/.telemachus/logs/discord-stdout.log`
  const stderrLog = `${homedir}/.telemachus/logs/discord-stderr.log`

  const lines: string[] = []
  lines.push(XML_HEADER)
  lines.push('<plist version="1.0">')
  lines.push('<dict>')

  // 1. Label
  lines.push('    <key>Label</key>')
  lines.push(`    <string>${escape(DISCORD_LABEL)}</string>`)

  // 2. ProgramArguments — single element: the launcher wrapper.
  //    The wrapper sources the bot token from Keychain (HYG-04) and execs
  //    `tm discord` with DISCORD_BOT_TOKEN exported.
  lines.push('    <key>ProgramArguments</key>')
  lines.push('    <array>')
  lines.push(`        <string>${escape(launcherPath)}</string>`)
  lines.push('    </array>')

  // 3. KeepAlive — auto-restart on crash (OPS-01)
  lines.push('    <key>KeepAlive</key>')
  lines.push('    <true/>')

  // 4. EnvironmentVariables — PATH only. Token is NOT embedded in plist.
  //    Default file mode 0o644 would have leaked the token to any process
  //    under the user's UID; Keychain provides per-app ACL instead.
  lines.push('    <key>EnvironmentVariables</key>')
  lines.push('    <dict>')
  lines.push('        <key>PATH</key>')
  lines.push(`        <string>${escape(envPath)}</string>`)
  lines.push('    </dict>')

  // 4b. WorkingDirectory — post-v3.6 hotfix. launchd defaults process.cwd()
  //     to '/' when no WorkingDirectory key is set, which trips the SAND-02
  //     sandbox-probe on every subagent spawn. initSandboxEnv also chdirs as
  //     a runtime safety net, but setting it at launchd level is belt-and-braces.
  lines.push('    <key>WorkingDirectory</key>')
  lines.push(`    <string>${escape(workingDir)}</string>`)

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
// discordInstall
// ————————————————————————————————————————————————————————————————————————

export interface DiscordInstallOpts {
  /** Absolute path to install the launcher script at (default: ~/.telemachus/scripts/kc-discord-launcher.sh). */
  launcherPath?: string
  /** Source path to copy the launcher script FROM (default: repo-relative scripts/kc-discord-launcher.sh).
   *  Tests pass a temp-dir source so the install doesn't require the repo layout. */
  launcherSource?: string
  /** Post-v3.6 hotfix: override the WorkingDirectory key written to the plist.
   *  Defaults to the homedir. Callers running from a repo checkout should pass
   *  the repo root so subagents don't trip the SAND-02 probe on fileroot cwd. */
  workingDirectory?: string
}

export async function discordInstall(
  runner: ProcessRunner,
  paths: InstallPaths,
  opts: DiscordInstallOpts = {},
): Promise<InstallResult> {
  const uid = await getUid(runner)
  const plistPath = path.join(paths.launchAgentsDir, `${DISCORD_LABEL}.plist`)
  const launcherPath = opts.launcherPath ?? defaultLauncherPath(paths.homedir)

  // Create logs directory before writing plist (OPS-01)
  await fs.mkdir(path.join(paths.homedir, '.telemachus', 'logs'), { recursive: true })

  // HYG-04: ensure the launcher script is installed at launcherPath BEFORE
  // writing the plist. Skip the copy when launcherSource is absent (tests
  // that don't care about the script body can omit it — they still assert
  // the plist references launcherPath correctly).
  if (opts.launcherSource !== undefined) {
    await fs.mkdir(path.dirname(launcherPath), { recursive: true })
    await fs.copyFile(opts.launcherSource, launcherPath)
    await fs.chmod(launcherPath, 0o755)
  }

  const xml = renderDiscordPlist({
    launcherPath,
    homedir: paths.homedir,
    ...(opts.workingDirectory !== undefined && { workingDirectory: opts.workingDirectory }),
  })

  await fs.mkdir(paths.launchAgentsDir, { recursive: true })

  const existed = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)
  const action: 'installed' | 'replaced' = existed ? 'replaced' : 'installed'

  // ALWAYS bootout first — idempotent-refresh (ignore wasLoaded)
  await bootout(runner, uid, DISCORD_LABEL)

  await fs.writeFile(plistPath, xml, { mode: 0o644 })
  await fs.chmod(plistPath, 0o644)

  await bootstrap(runner, uid, plistPath)

  return { label: DISCORD_LABEL, plistPath, action }
}

// ————————————————————————————————————————————————————————————————————————
// discordUninstall
// ————————————————————————————————————————————————————————————————————————

export async function discordUninstall(
  runner: ProcessRunner,
  paths: InstallPaths,
): Promise<{ action: 'uninstalled' | 'not installed' }> {
  const plistPath = path.join(paths.launchAgentsDir, `${DISCORD_LABEL}.plist`)
  const uid = await getUid(runner)

  const fileExists = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)

  const { wasLoaded } = await bootout(runner, uid, DISCORD_LABEL)

  // OPS-02: idempotent — not installed is success, not error
  if (!fileExists && !wasLoaded) {
    return { action: 'not installed' }
  }

  await fs.unlink(plistPath).catch(() => {})
  return { action: 'uninstalled' }
}
