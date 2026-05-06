/**
 * Phase 39: Shared git helper extracted from src/tools/builtin/worktree.ts.
 *
 * Provides a single `runGit` utility that both the worktree tool and the
 * orchestration worker module can import without duplicating the implementation.
 *
 * Phase 41: Adds a worktree mutex to serialize `git worktree add/remove`
 * operations. Git takes an internal lock during these operations; concurrent
 * calls fail with "fatal: could not lock config file". The mutex ensures
 * only one worktree operation runs at a time across all concurrent tasks.
 * Fixes PITFALLS P9: worktree lock contention.
 */

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/**
 * Module-level promise chain for serializing git worktree operations.
 * Each acquire chains onto the previous, ensuring sequential execution.
 */
let worktreeMutex: Promise<void> = Promise.resolve()

/**
 * Acquire exclusive access for git worktree add/remove operations.
 * Returns a release function. Callers MUST call release() when done.
 *
 * Pattern: chain a new Promise onto the mutex, capturing the resolver
 * as the release function. This creates a queue of waiters; each waiter
 * resolves only after the previous one releases.
 *
 * Example:
 *   const release = await acquireWorktreeLock()
 *   try { await runGit(['worktree', 'add', ...], cwd) }
 *   finally { release() }
 */
export async function acquireWorktreeLock(): Promise<() => void> {
  let release!: () => void
  const acquired = new Promise<void>((resolve) => {
    release = resolve
  })
  const prev = worktreeMutex
  worktreeMutex = acquired
  await prev
  return release
}

/**
 * Run a git worktree operation with exclusive locking.
 * Automatically acquires and releases the worktree mutex.
 *
 * @param fn - the worktree operation to execute under the lock
 * @returns the result of fn
 */
export async function withWorktreeLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireWorktreeLock()
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Run a git command in the given working directory with a timeout.
 *
 * On timeout the child process is killed and `timedOut` is set to true.
 * The function never throws — callers inspect exitCode / timedOut.
 */
export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = 30_000,
): Promise<GitResult> {
  let timedOut = false
  // Unset GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE so that CI environments
  // (e.g. GitHub Actions checkout) cannot override the cwd-based git repo
  // resolution. Without this, a GIT_DIR env var set by the CI runner would
  // make every `git rev-parse --git-dir` return 0 regardless of cwd.
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
  }, timeoutMs)
  await proc.exited
  clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, exitCode: proc.exitCode ?? 0, timedOut }
}
