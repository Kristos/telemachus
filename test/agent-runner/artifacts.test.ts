import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  prepareRunDir,
  writeResult,
  writeUsage,
  writeConfig,
  updateLatestSymlink,
  sanitizeTimestamp,
} from '../../src/agent-runner/artifacts.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-artifacts-'))
})

afterEach(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

describe('artifacts — timestamp sanitization', () => {
  test('replaces colons and strips milliseconds', () => {
    expect(sanitizeTimestamp('2026-04-08T14:30:00.123Z')).toBe('2026-04-08T14-30-00Z')
  })

  test('handles zero-ms timestamp', () => {
    expect(sanitizeTimestamp('2026-04-08T14:30:00Z')).toBe('2026-04-08T14-30-00Z')
  })
})

describe('artifacts — prepareRunDir', () => {
  test('creates nested run dir and returns four artifact paths', async () => {
    const paths = await prepareRunDir(tmpHome, 'nightly', '2026-04-08T14:30:00.000Z')
    const stat = await fsp.stat(paths.runDir)
    expect(stat.isDirectory()).toBe(true)
    expect(paths.runDirName).toBe('2026-04-08T14-30-00Z')
    expect(paths.logPath).toBe(path.join(paths.runDir, 'log.txt'))
    expect(paths.resultPath).toBe(path.join(paths.runDir, 'result.md'))
    expect(paths.usagePath).toBe(path.join(paths.runDir, 'usage.json'))
    expect(paths.configPath).toBe(path.join(paths.runDir, 'config.json'))
    expect(paths.parentDir).toBe(
      path.join(tmpHome, '.telemachus', 'agent-runs', 'nightly'),
    )
  })
})

describe('artifacts — write helpers', () => {
  test('writeResult / writeUsage / writeConfig round-trip', async () => {
    const paths = await prepareRunDir(tmpHome, 'job', '2026-04-08T14:30:00.000Z')
    await writeResult(paths.runDir, 'hello world')
    await writeUsage(paths.runDir, { exit_reason: 'natural', turn_count: 3 })
    await writeConfig(paths.runDir, { prompt: 'hi' })

    expect(await fsp.readFile(paths.resultPath, 'utf8')).toBe('hello world')
    expect(JSON.parse(await fsp.readFile(paths.usagePath, 'utf8'))).toEqual({
      exit_reason: 'natural',
      turn_count: 3,
    })
    expect(JSON.parse(await fsp.readFile(paths.configPath, 'utf8'))).toEqual({
      prompt: 'hi',
    })
  })
})

describe('artifacts — updateLatestSymlink', () => {
  test('creates symlink pointing at the run dir name', async () => {
    const paths = await prepareRunDir(tmpHome, 'job', '2026-04-08T14:30:00.000Z')
    await updateLatestSymlink(paths.parentDir, paths.runDirName)
    const linkTarget = await fsp.readlink(path.join(paths.parentDir, 'latest'))
    expect(linkTarget).toBe(paths.runDirName)
  })

  test('atomically re-points latest on a second call', async () => {
    const first = await prepareRunDir(tmpHome, 'job', '2026-04-08T14:30:00.000Z')
    const second = await prepareRunDir(tmpHome, 'job', '2026-04-08T15:00:00.000Z')
    await updateLatestSymlink(first.parentDir, first.runDirName)
    await updateLatestSymlink(second.parentDir, second.runDirName)
    const linkTarget = await fsp.readlink(path.join(first.parentDir, 'latest'))
    expect(linkTarget).toBe(second.runDirName)
  })

  test('refuses to clobber a non-symlink `latest` file', async () => {
    const paths = await prepareRunDir(tmpHome, 'job', '2026-04-08T14:30:00.000Z')
    const finalPath = path.join(paths.parentDir, 'latest')
    await fsp.writeFile(finalPath, 'i am a real file')
    await updateLatestSymlink(paths.parentDir, paths.runDirName)
    // Should still be the regular file — untouched.
    const st = await fsp.lstat(finalPath)
    expect(st.isSymbolicLink()).toBe(false)
    expect(await fsp.readFile(finalPath, 'utf8')).toBe('i am a real file')
  })
})
