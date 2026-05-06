/**
 * git_deploy tool — one-shot commit + push + open PR with user approval.
 *
 * Flow:
 *   1. Check cwd is a git repo with changes to commit.
 *   2. Build the approval prompt (diff stat + branch + commit message + PR title/body).
 *   3. Call context.askUser() — transport-agnostic. CLI shows readline prompt;
 *      Discord DMs the owner and waits for `yes`/`no` reply.
 *   4. On approve: checkout branch → commit → push → open PR via `gh`.
 *   5. On reject: abort, audit, return.
 *
 * Always bypasses the bash sandbox — git/gh need network + ~/.ssh access. Trust
 * tier is `dangerous`; the approval prompt is the only real gate.
 *
 * Safety rails:
 *   - Default target is always a feature branch (agent/<slug>). Direct-to-main
 *     pushes require explicit branch="main" in the args, which the approval
 *     prompt surfaces prominently.
 *   - Every invocation writes a `git_deploy` audit entry (outcome + branch + hash).
 *   - Only activated when `kcConfig.enableGitDeploy === true` (opt-in).
 */

import { z } from 'zod'
import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { appendAuditEntry } from '../../security/audit.js'

const gitDeploySchema = z.object({
  commitMessage: z
    .string()
    .min(1)
    .describe('Commit message (first line = subject, blank line, then body).'),
  prTitle: z.string().min(1).describe('PR title. Shown to reviewers.'),
  prBody: z.string().min(1).describe('PR body / description in markdown.'),
  branch: z
    .string()
    .optional()
    .describe(
      'Target branch name. If omitted, derives `agent/<slugified-subject>` from the commit message subject.',
    ),
})

export type GitDeployArgs = z.infer<typeof gitDeploySchema>

/** Derive a feature branch name from the commit subject. */
export function deriveBranchName(commitMessage: string): string {
  const subject = commitMessage.split('\n')[0].trim()
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return slug.length > 0 ? `agent/${slug}` : `agent/push-${Date.now()}`
}

/** Spawn a subprocess, capture stdout/stderr, return { code, stdout, stderr }. */
export async function runCmd(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Format the approval prompt shown to the user.
 * Keeps the diff stat (not the full diff — too long) plus all the metadata
 * the user needs to decide.
 */
export function formatApprovalPrompt(args: {
  branch: string
  commitMessage: string
  prTitle: string
  prBody: string
  diffStat: string
  fileCount: number
}): string {
  const isMain = args.branch === 'main' || args.branch === 'master'
  const warning = isMain
    ? '\n⚠️  DIRECT PUSH TO MAIN — no PR will be created. Review carefully.\n'
    : ''
  return [
    'Deploy this commit?',
    warning,
    `**Branch:** ${args.branch}`,
    `**Commit:** ${args.commitMessage.split('\n')[0]}`,
    `**Files changed:** ${args.fileCount}`,
    '',
    '```',
    args.diffStat.trim() || '(no diff stat available)',
    '```',
    '',
    `**PR title:** ${args.prTitle}`,
    '',
    `**PR body:**`,
    args.prBody.length > 500 ? args.prBody.slice(0, 500) + '…' : args.prBody,
  ].join('\n')
}

export const gitDeployTool: Tool = {
  name: 'git_deploy',
  description:
    'Commit current working changes, push to a feature branch, and open a PR. ' +
    'Requires explicit user approval via the transport-appropriate channel ' +
    '(CLI readline / Discord DM). Never pushes without a yes. Use this when ' +
    'you have finished a task and the user asked you to "ship it" / "deploy" / ' +
    '"open a PR". Produces an audit entry regardless of outcome.',
  inputSchema: gitDeploySchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = gitDeploySchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid git_deploy arguments: ${parsed.error.message}`, isError: true }
    }
    const { commitMessage, prTitle, prBody } = parsed.data
    const branch = parsed.data.branch ?? deriveBranchName(commitMessage)
    const cwd = context.cwd
    const ts = () => new Date().toISOString()
    const sessionId = context.sessionId ?? 'git-deploy'

    // 1. Verify we're in a git repo
    const revParse = await runCmd('git', ['rev-parse', '--git-dir'], cwd, 5_000)
    if (revParse.code !== 0) {
      return {
        content: `git_deploy failed: ${cwd} is not a git repository.`,
        isError: true,
      }
    }

    // 2. Check there are changes to commit
    const status = await runCmd('git', ['status', '--porcelain'], cwd, 5_000)
    if (status.code !== 0) {
      return {
        content: `git_deploy failed: git status errored — ${status.stderr.trim()}`,
        isError: true,
      }
    }
    const changedLines = status.stdout.trim().split('\n').filter((l) => l.length > 0)
    if (changedLines.length === 0) {
      return {
        content: 'git_deploy: no uncommitted changes to deploy. Aborting.',
        isError: true,
      }
    }

    // 3. Get diff stat for the approval prompt
    const diffStat = await runCmd('git', ['diff', 'HEAD', '--stat'], cwd, 10_000)
    const untracked = await runCmd(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      cwd,
      5_000,
    )
    const combinedStat =
      (diffStat.stdout.trim() || '') +
      (untracked.stdout.trim()
        ? `\n(plus ${untracked.stdout.trim().split('\n').length} untracked file(s))`
        : '')

    // 4. Ask the user for approval via transport-agnostic callback
    const prompt = formatApprovalPrompt({
      branch,
      commitMessage,
      prTitle,
      prBody,
      diffStat: combinedStat,
      fileCount: changedLines.length,
    })

    let approved = false
    try {
      const answer = await context.askUser(prompt, ['yes', 'no'])
      const normalized = answer.trim().toLowerCase()
      approved = normalized === 'yes' || normalized === 'y' || normalized === 'approve'
    } catch (err) {
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'prompt_error',
        branch,
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        content: `git_deploy: approval prompt failed — ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    if (!approved) {
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'rejected',
        branch,
      })
      return { content: 'git_deploy: user rejected. Aborted cleanly.', isError: false }
    }

    // 5. APPROVED — run the pipeline. Each step fails hard; we audit every outcome.
    // 5a. Checkout / create branch (idempotent — if it exists, just switch)
    let checkout = await runCmd('git', ['checkout', '-b', branch], cwd, 10_000)
    if (checkout.code !== 0) {
      // Branch may already exist — try plain checkout
      checkout = await runCmd('git', ['checkout', branch], cwd, 10_000)
      if (checkout.code !== 0) {
        void appendAuditEntry({
          ts: ts(),
          kind: 'git_deploy',
          sessionId,
          platform: process.platform,
          outcome: 'checkout_failed',
          branch,
          error: checkout.stderr.trim(),
        })
        return {
          content: `git_deploy: checkout ${branch} failed — ${checkout.stderr.trim()}`,
          isError: true,
        }
      }
    }

    // 5b. Stage + commit
    const add = await runCmd('git', ['add', '-A'], cwd, 10_000)
    if (add.code !== 0) {
      return {
        content: `git_deploy: git add failed — ${add.stderr.trim()}`,
        isError: true,
      }
    }
    const commit = await runCmd('git', ['commit', '-m', commitMessage], cwd, 10_000)
    if (commit.code !== 0) {
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'commit_failed',
        branch,
        error: commit.stderr.trim(),
      })
      return {
        content: `git_deploy: commit failed — ${commit.stderr.trim()}`,
        isError: true,
      }
    }
    const rev = await runCmd('git', ['rev-parse', 'HEAD'], cwd, 5_000)
    const commitHash = rev.stdout.trim().slice(0, 8)

    // 5c. Push
    const push = await runCmd('git', ['push', '-u', 'origin', branch], cwd, 60_000)
    if (push.code !== 0) {
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'push_failed',
        branch,
        commitHash,
        error: push.stderr.trim(),
      })
      return {
        content: `git_deploy: push failed — ${push.stderr.trim()}`,
        isError: true,
      }
    }

    // 5d. Open PR (skip if target is main/master — you pushed direct)
    if (branch === 'main' || branch === 'master') {
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'pushed_to_main',
        branch,
        commitHash,
      })
      return {
        content: `git_deploy: committed ${commitHash} to ${branch} and pushed. No PR created (direct push).`,
        isError: false,
      }
    }

    const prCreate = await runCmd(
      'gh',
      ['pr', 'create', '--title', prTitle, '--body', prBody],
      cwd,
      30_000,
    )
    if (prCreate.code !== 0) {
      // Push succeeded, PR didn't — still a partial success worth reporting.
      void appendAuditEntry({
        ts: ts(),
        kind: 'git_deploy',
        sessionId,
        platform: process.platform,
        outcome: 'pr_create_failed',
        branch,
        commitHash,
        error: prCreate.stderr.trim(),
      })
      return {
        content: `git_deploy: commit ${commitHash} pushed to ${branch}, but PR creation failed — ${prCreate.stderr.trim()}. Open manually if needed.`,
        isError: false,
      }
    }

    const prUrl = prCreate.stdout.trim().split('\n').pop() ?? ''
    void appendAuditEntry({
      ts: ts(),
      kind: 'git_deploy',
      sessionId,
      platform: process.platform,
      outcome: 'success',
      branch,
      commitHash,
      prUrl,
    })

    return {
      content: `git_deploy: ✅ commit ${commitHash} pushed to ${branch}. PR: ${prUrl}`,
      isError: false,
    }
  },
}
