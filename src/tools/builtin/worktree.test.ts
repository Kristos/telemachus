import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { worktreeTool } from './worktree.js'
import type { ToolContext } from '../types.js'

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    exitCode: proc.exitCode ?? 0,
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

let tmpRoot: string
let repoDir: string
let context: ToolContext

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'wt-test-'))
  repoDir = join(tmpRoot, 'repo')
  await run(['git', 'init', '-q', '-b', 'main', repoDir], tmpRoot)
  await run(['git', 'config', 'user.email', 'test@test.com'], repoDir)
  await run(['git', 'config', 'user.name', 'Test'], repoDir)
  await writeFile(join(repoDir, 'README.md'), '# test\n')
  await run(['git', 'add', '.'], repoDir)
  await run(['git', 'commit', '-q', '-m', 'init'], repoDir)
  context = {
    cwd: repoDir,
    toolTimeoutMs: 10_000,
    askUser: async () => '',
  }
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('worktreeTool', () => {
  test('list on fresh repo returns the main worktree', async () => {
    const res = await worktreeTool.execute({ action: 'list' }, context)
    expect(res.isError).toBe(false)
    const parsed = JSON.parse(res.content)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThanOrEqual(1)
    expect(parsed[0].path).toContain('repo')
  })

  test('create with branch creates worktree on disk', async () => {
    const wtPath = join(tmpRoot, 'wt-feature')
    const res = await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'feature/x' },
      context,
    )
    expect(res.isError).toBe(false)
    expect(await exists(wtPath)).toBe(true)
    expect(res.content).toContain(wtPath)
  })

  test('create without branch uses HEAD', async () => {
    const wtPath = join(tmpRoot, 'wt-head')
    const res = await worktreeTool.execute(
      { action: 'create', path: wtPath },
      context,
    )
    expect(res.isError).toBe(false)
    expect(await exists(wtPath)).toBe(true)
  })

  test('remove of clean worktree succeeds', async () => {
    const wtPath = join(tmpRoot, 'wt-clean')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'clean-branch' },
      context,
    )
    const res = await worktreeTool.execute({ action: 'remove', path: wtPath }, context)
    expect(res.isError).toBe(false)
    expect(await exists(wtPath)).toBe(false)
  })

  test('remove of dirty worktree without force fails', async () => {
    const wtPath = join(tmpRoot, 'wt-dirty')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'dirty-branch' },
      context,
    )
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted\n')
    const res = await worktreeTool.execute({ action: 'remove', path: wtPath }, context)
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/uncommitted|force/i)
    expect(await exists(wtPath)).toBe(true)
  })

  test('remove with force=true on dirty worktree succeeds', async () => {
    const wtPath = join(tmpRoot, 'wt-force')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'force-branch' },
      context,
    )
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted\n')
    const res = await worktreeTool.execute(
      { action: 'remove', path: wtPath, force: true },
      context,
    )
    expect(res.isError).toBe(false)
    expect(await exists(wtPath)).toBe(false)
  })

  test('invalid action returns Zod error', async () => {
    const res = await worktreeTool.execute({ action: 'bogus' }, context)
    expect(res.isError).toBe(true)
  })

  test('create with cwdRef updates session cwd to new worktree path', async () => {
    const wtPath = join(tmpRoot, 'wt-cwdref')
    let current = repoDir
    const cwdRef = { get: () => current, set: (next: string) => { current = next } }
    const ctx: ToolContext = { ...context, cwdRef, originalCwd: repoDir }
    const res = await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'cwdref-branch' },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(current).toBe(wtPath)
    expect(res.content).toMatch(/Session cwd switched/i)
  })

  test('remove of current worktree restores cwd to originalCwd', async () => {
    const wtPath = join(tmpRoot, 'wt-restore')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'restore-branch' },
      context,
    )
    let current = wtPath
    const cwdRef = { get: () => current, set: (next: string) => { current = next } }
    const ctx: ToolContext = { ...context, cwdRef, originalCwd: repoDir }
    const res = await worktreeTool.execute(
      { action: 'remove', path: wtPath },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(current).toBe(repoDir)
    expect(res.content).toMatch(/Session cwd restored/i)
  })

  test('remove of non-current worktree does not touch cwdRef', async () => {
    const wtPath = join(tmpRoot, 'wt-other')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'other-branch' },
      context,
    )
    let current = repoDir
    const cwdRef = { get: () => current, set: (next: string) => { current = next } }
    const ctx: ToolContext = { ...context, cwdRef, originalCwd: repoDir }
    const res = await worktreeTool.execute(
      { action: 'remove', path: wtPath },
      ctx,
    )
    expect(res.isError).toBe(false)
    expect(current).toBe(repoDir)
  })

  test('git failure (path collision) returns isError with stderr', async () => {
    const wtPath = join(tmpRoot, 'wt-collide')
    await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'b1' },
      context,
    )
    const res = await worktreeTool.execute(
      { action: 'create', path: wtPath, branch: 'b2' },
      context,
    )
    expect(res.isError).toBe(true)
    expect(res.content.length).toBeGreaterThan(0)
  })
})
