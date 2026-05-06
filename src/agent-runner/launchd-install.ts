/**
 * Phase 24-02 (AGENT-07): launchd install/uninstall/list orchestrator.
 *
 * Ties together Plan 24-01's pure pieces (parseSchedule, renderPlist) with
 * Plan 24-02's ProcessRunner wrapper to implement the three subcommands.
 *
 * Design rules:
 *   - `install` is ALWAYS idempotent-refresh: bootout first (tolerate
 *     not-loaded), write plist, bootstrap. No conditional on whether it was
 *     previously loaded. This is the simplest path that handles all states.
 *   - `uninstall` tolerates not-loaded as success and NEVER touches
 *     `~/.telemachus/agent-runs/` (that's evidence of past runs).
 *   - `list` fails soft: per-field `?` on parse failure, never aborts the
 *     whole command because of one broken plist.
 *   - All paths are injected via `InstallPaths` so tests use temp dirs.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentJobConfig } from './config-schema'
import type { KristosConfig } from '../config/types'
import { parseSchedule } from './schedule-parse'
import { renderPlist } from './launchd-plist'
import { findProjectRoot } from '../discord/sandbox-env'
import {
  bootout,
  bootstrap,
  getUid,
  print,
  whichKc,
  type ProcessRunner,
} from './launchctl'

export interface InstallPaths {
  launchAgentsDir: string
  homedir: string
}

export interface InstallResult {
  label: string
  plistPath: string
  action: 'installed' | 'replaced'
}

const LABEL_PREFIX = 'com.telemachus.agent.'

function labelFor(name: string): string {
  return `${LABEL_PREFIX}${name}`
}

function buildEnvPath(homedir: string): string {
  return `${homedir}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
}

// ————————————————————————————————————————————————————————————————————————
// install
// ————————————————————————————————————————————————————————————————————————

export async function install(
  name: string,
  jobCfg: AgentJobConfig,
  runner: ProcessRunner,
  paths: InstallPaths,
): Promise<InstallResult> {
  if (!jobCfg.schedule) {
    throw new Error(
      `agent job '${name}' has no schedule; add \`schedule: "hourly" | "daily" | "cron: M H D M DoW"\` to config.agents.${name}`,
    )
  }

  const calendarInterval = parseSchedule(jobCfg.schedule)
  const uid = await getUid(runner)
  const kcPrefix = await whichKc(runner)
  const envPath = buildEnvPath(paths.homedir)
  const label = labelFor(name)
  const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)

  // Post-v3.8 hotfix: derive WorkingDirectory from the kc script path (kcPrefix[1])
  // so launchd starts the job inside the repo, not at fileroot '/'. Falls back
  // to homedir if we can't locate .git (matches sandbox-env.ts priority order).
  const scriptPath = kcPrefix[1]
  const workingDirectory =
    (scriptPath ? findProjectRoot(path.dirname(scriptPath)) : undefined) ?? paths.homedir

  const xml = renderPlist({
    label,
    programArguments: [...kcPrefix, 'agent', 'run', name],
    calendarInterval,
    envPath,
    workingDirectory,
  })

  await fs.mkdir(paths.launchAgentsDir, { recursive: true })

  const existed = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)
  const action: 'installed' | 'replaced' = existed ? 'replaced' : 'installed'

  // ALWAYS bootout first — idempotent-refresh (Pattern 2). Ignore wasLoaded.
  await bootout(runner, uid, label)

  await fs.writeFile(plistPath, xml, { mode: 0o644 })
  await fs.chmod(plistPath, 0o644) // belt + braces (Pitfall 11)

  await bootstrap(runner, uid, plistPath)

  return { label, plistPath, action }
}

// ————————————————————————————————————————————————————————————————————————
// uninstall
// ————————————————————————————————————————————————————————————————————————

export async function uninstall(
  name: string,
  runner: ProcessRunner,
  paths: InstallPaths,
): Promise<{ action: 'uninstalled' | 'not installed' }> {
  const label = labelFor(name)
  const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
  const uid = await getUid(runner)

  const fileExists = await fs
    .stat(plistPath)
    .then(() => true)
    .catch(() => false)

  const { wasLoaded } = await bootout(runner, uid, label)

  if (!fileExists && !wasLoaded) {
    return { action: 'not installed' }
  }

  await fs.unlink(plistPath).catch(() => {})
  return { action: 'uninstalled' }
}

// ————————————————————————————————————————————————————————————————————————
// list
// ————————————————————————————————————————————————————————————————————————

export interface ListRow {
  name: string
  schedule: string
  installed: boolean
  loaded: boolean
  nextFire: string
  running: string // 'y' | 'n' | '?'
}

export async function list(
  config: KristosConfig,
  runner: ProcessRunner,
  paths: InstallPaths,
): Promise<ListRow[]> {
  const agents = config.agents ?? {}
  const names = Object.keys(agents).sort()
  if (names.length === 0) return []

  const uid = await getUid(runner)
  const rows: ListRow[] = []

  for (const name of names) {
    const jobCfg = agents[name]!
    const label = labelFor(name)
    const plistPath = path.join(paths.launchAgentsDir, `${label}.plist`)
    const installed = await fs
      .stat(plistPath)
      .then(() => true)
      .catch(() => false)

    let loaded = false
    let nextFire: string | null = null
    let running: boolean | null = null

    if (installed) {
      try {
        const info = await print(runner, uid, label)
        loaded = info.loaded
        nextFire = info.nextFire
        running = info.running
      } catch {
        // per-job parse failure → fall back to `?`
        loaded = false
        nextFire = null
        running = null
      }
    }

    rows.push({
      name,
      schedule: jobCfg.schedule ?? '?',
      installed,
      loaded,
      nextFire: nextFire ?? '?',
      running: running === null ? '?' : running ? 'y' : 'n',
    })
  }

  return rows
}

// ————————————————————————————————————————————————————————————————————————
// formatter (reuses width-padding pattern from status.ts)
// ————————————————————————————————————————————————————————————————————————

const EMPTY_LIST_MESSAGE =
  'No agent jobs configured in ~/.telemachus/config.json\n'

export function formatListTable(rows: ListRow[]): string {
  if (rows.length === 0) return EMPTY_LIST_MESSAGE

  const headers = ['NAME', 'SCHEDULE', 'INSTALLED', 'LOADED', 'NEXT FIRE', 'RUNNING']
  const data = rows.map((r) => [
    r.name,
    r.schedule,
    r.installed ? 'y' : 'n',
    r.loaded ? 'y' : 'n',
    r.nextFire,
    r.running,
  ])

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  )
  const pad = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')

  return [pad(headers), sep, ...data.map(pad)].join('\n') + '\n'
}
