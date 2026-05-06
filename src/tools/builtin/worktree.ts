import { z } from 'zod'
import { resolve as resolvePath } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { runGit, type GitResult } from '../../orchestration/git.js'

const worktreeSchema = z.object({
  action: z.enum(['create', 'remove', 'list']),
  path: z.string().optional(),
  branch: z.string().optional(),
  force: z.boolean().optional(),
})

interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  bare?: boolean
  detached?: boolean
}

function parsePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of out.split('\n')) {
    if (line === '') {
      if (current) {
        entries.push(current)
        current = null
      }
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current) {
      if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length)
      else if (line === 'bare') current.bare = true
      else if (line === 'detached') current.detached = true
    }
  }
  if (current) entries.push(current)
  return entries
}

function gitError(stderr: string, exitCode: number): ToolResult {
  const msg = stderr.trim() || `git exited ${exitCode}`
  return { content: msg, isError: true }
}

export const worktreeTool: Tool = {
  name: 'worktree',
  description:
    'Manage git worktrees. Actions: create (path, optional branch), remove (path, optional force), list. ' +
    'Refuses to remove dirty worktrees unless force=true.',
  inputSchema: worktreeSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = worktreeSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }
    const { action, path, branch, force } = parsed.data
    const cwd = context.cwd
    const timeout = context.toolTimeoutMs

    if (action === 'list') {
      const r = await runGit(['worktree', 'list', '--porcelain'], cwd, timeout)
      if (r.exitCode !== 0) return gitError(r.stderr, r.exitCode)
      return { content: JSON.stringify(parsePorcelain(r.stdout)), isError: false }
    }

    if (action === 'create') {
      if (!path) return { content: 'create requires path', isError: true }
      const args = ['worktree', 'add']
      if (branch) args.push('-b', branch)
      args.push(path)
      const r = await runGit(args, cwd, timeout)
      if (r.exitCode !== 0) return gitError(r.stderr, r.exitCode)
      const branchLine = branch ? ` on branch ${branch}` : ''
      const absPath = resolvePath(cwd, path)
      let cwdNote = ''
      if (context.cwdRef) {
        context.cwdRef.set(absPath)
        cwdNote = `\nSession cwd switched to ${absPath}`
      }
      return { content: `Created worktree at ${path}${branchLine}${cwdNote}`, isError: false }
    }

    if (action === 'remove') {
      if (!path) return { content: 'remove requires path', isError: true }
      // Check for dirt unless forced
      if (!force) {
        const status = await runGit(['-C', path, 'status', '--porcelain'], cwd, timeout)
        if (status.exitCode === 0 && status.stdout.trim().length > 0) {
          return {
            content: `Worktree at ${path} has uncommitted changes. Pass force=true to remove anyway.`,
            isError: true,
          }
        }
      }
      const args = ['worktree', 'remove']
      if (force) args.push('--force')
      args.push(path)
      const r = await runGit(args, cwd, timeout)
      if (r.exitCode !== 0) return gitError(r.stderr, r.exitCode)
      const absPath = resolvePath(cwd, path)
      let cwdNote = ''
      if (context.cwdRef && context.originalCwd && context.cwdRef.get() === absPath) {
        context.cwdRef.set(context.originalCwd)
        cwdNote = `\nSession cwd restored to ${context.originalCwd}`
      }
      return { content: `Removed worktree at ${path}${cwdNote}`, isError: false }
    }

    return { content: `Unknown action: ${action}`, isError: true }
  },
}
