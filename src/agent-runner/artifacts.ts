/**
 * Phase 22 Wave 2 (AGENT-01 / AGENT-02): filesystem artifacts for a headless
 * agent run. Layout:
 *
 *   $HOME/.telemachus/agent-runs/
 *     <jobName>/
 *       <sanitized-timestamp>/
 *         log.txt      — stdout+stderr tee
 *         result.md    — final assistant text
 *         usage.json   — totals, duration, exit_reason, error
 *         config.json  — effective AgentJobConfig that ran
 *       latest           — symlink → most recent <sanitized-timestamp>
 *
 * Timestamp sanitization: `2026-04-08T14:30:00.123Z` → `2026-04-08T14-30-00Z`
 * (colons are illegal on some filesystems; milliseconds are dropped for
 * readability — the run is already uniquely named by the date + seconds).
 *
 * The `latest` symlink is updated atomically via write-then-rename: write
 * a fresh symlink at `.latest.tmp`, then `fs.rename` it to `latest`. `rename`
 * on POSIX atomically replaces an existing symlink. If `latest` exists as a
 * regular file (not a symlink), the update is skipped and a warning is
 * written to stderr — we never clobber non-symlink data at that path.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ArtifactPaths {
  runDir: string
  runDirName: string
  parentDir: string
  logPath: string
  resultPath: string
  usagePath: string
  configPath: string
}

export function sanitizeTimestamp(iso: string): string {
  // 2026-04-08T14:30:00.123Z → 2026-04-08T14-30-00Z
  return iso.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z')
}

export async function prepareRunDir(
  home: string,
  jobName: string,
  nowIso: string,
): Promise<ArtifactPaths> {
  const runDirName = sanitizeTimestamp(nowIso)
  const parentDir = path.join(home, '.telemachus', 'agent-runs', jobName)
  const runDir = path.join(parentDir, runDirName)
  await fs.mkdir(runDir, { recursive: true })
  return {
    runDir,
    runDirName,
    parentDir,
    logPath: path.join(runDir, 'log.txt'),
    resultPath: path.join(runDir, 'result.md'),
    usagePath: path.join(runDir, 'usage.json'),
    configPath: path.join(runDir, 'config.json'),
  }
}

export async function writeResult(runDir: string, text: string): Promise<void> {
  await fs.writeFile(path.join(runDir, 'result.md'), text, 'utf8')
}

export async function writeUsage(runDir: string, obj: unknown): Promise<void> {
  await fs.writeFile(
    path.join(runDir, 'usage.json'),
    JSON.stringify(obj, null, 2) + '\n',
    'utf8',
  )
}

export async function writeConfig(runDir: string, cfg: unknown): Promise<void> {
  await fs.writeFile(
    path.join(runDir, 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n',
    'utf8',
  )
}

/**
 * Atomically update `parentDir/latest` to point at `runDirName`.
 *
 * Protocol:
 *   1. Stat existing `latest` (if any). If it's a regular file or directory
 *      — NOT a symlink — skip and warn. We never clobber real data.
 *   2. Write fresh symlink at `parentDir/.latest.tmp`. Retry once on EEXIST
 *      (unlink + retry).
 *   3. `fs.rename(tmpPath, finalPath)` — atomic replace on POSIX.
 */
export async function updateLatestSymlink(
  parentDir: string,
  runDirName: string,
): Promise<void> {
  const finalPath = path.join(parentDir, 'latest')
  const tmpPath = path.join(parentDir, '.latest.tmp')

  // Safety: if `latest` exists as a regular file/dir, bail out loudly.
  try {
    const st = await fs.lstat(finalPath)
    if (!st.isSymbolicLink()) {
      process.stderr.write(
        `[agent-runner] refusing to replace non-symlink at ${finalPath}\n`,
      )
      return
    }
  } catch {
    // Doesn't exist yet — fine, we'll create it.
  }

  // Clean up a leftover tmp symlink from a crashed prior run.
  try {
    await fs.unlink(tmpPath)
  } catch {
    // didn't exist — fine
  }

  try {
    await fs.symlink(runDirName, tmpPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // Race with another writer — unlink and retry once.
      await fs.unlink(tmpPath).catch(() => {})
      await fs.symlink(runDirName, tmpPath)
    } else {
      throw err
    }
  }

  await fs.rename(tmpPath, finalPath)
}
