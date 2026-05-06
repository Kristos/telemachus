/**
 * `tm deploy` subcommand — one-shot approval-gated commit + push + open PR.
 *
 * Usage:
 *   tm deploy --message "<commit message>" [--pr-title "..."] [--pr-body "..."] [--branch foo]
 *
 * Reads stdin for the approval answer. Invokes gitDeployTool with a readline-
 * based askUser callback. On success prints the PR URL to stdout.
 */

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { gitDeployTool } from '../tools/builtin/git-deploy.js'
import type { ToolContext } from '../tools/types.js'

export async function runDeploySubcommand(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args,
      options: {
        message: { type: 'string', short: 'm' },
        'pr-title': { type: 'string' },
        'pr-body': { type: 'string' },
        branch: { type: 'string', short: 'b' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch (err) {
    process.stderr.write(`tm deploy: ${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write('Try `tm deploy --help` for usage.\n')
    process.exit(2)
  }

  const { values } = parsed

  if (values.help) {
    process.stdout.write(`tm deploy — Commit current changes, push to a feature branch, open a PR.

Usage:
  tm deploy --message "<commit message>" [options]

Required:
  --message, -m <msg>             Commit message (first line = subject)

Optional:
  --pr-title "<title>"            PR title (defaults to commit subject)
  --pr-body "<body>"              PR body (defaults to auto-generated)
  --branch, -b <name>             Target branch (defaults to agent/<subject-slug>)
  --help, -h                      Show this help

Flow:
  1. Checks you're in a git repo with uncommitted changes.
  2. Shows the diff stat, branch, commit message, PR title/body.
  3. Asks you to type 'yes' to approve.
  4. On yes: checks out branch, commits, pushes, opens PR via \`gh\`.
  5. On no: aborts cleanly.

All outcomes are recorded in the audit log as a \`git_deploy\` entry.
`)
    process.exit(0)
  }

  const commitMessage = typeof values.message === 'string' ? values.message : undefined
  if (!commitMessage) {
    process.stderr.write('tm deploy: --message is required.\n')
    process.stderr.write('Try `tm deploy --help` for usage.\n')
    process.exit(2)
  }

  const prTitleRaw = values['pr-title']
  const prBodyRaw = values['pr-body']
  const branchRaw = values.branch
  const prTitle =
    typeof prTitleRaw === 'string' ? prTitleRaw : commitMessage.split('\n')[0]
  const prBody =
    typeof prBodyRaw === 'string'
      ? prBodyRaw
      : `${commitMessage}\n\n_Opened via \`tm deploy\`._`
  const branch = typeof branchRaw === 'string' ? branchRaw : undefined

  // Build readline-based askUser. Prints the formatted prompt to stdout,
  // reads a single line from stdin, returns it trimmed.
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const askUser = async (question: string, _options: string[]): Promise<string> => {
    process.stdout.write('\n' + question + '\n\n')
    const answer = await rl.question('Proceed? (yes/no) ')
    return answer
  }

  const ctx: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 60_000,
    askUser,
    sessionId: `kc-deploy-cli-${Date.now()}`,
  }

  try {
    const result = await gitDeployTool.execute(
      {
        commitMessage,
        prTitle,
        prBody,
        branch,
      },
      ctx,
    )

    process.stdout.write('\n' + result.content + '\n')
    process.exit(result.isError ? 1 : 0)
  } finally {
    rl.close()
  }
}
