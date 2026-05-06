import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveBranchName,
  formatApprovalPrompt,
  runCmd,
  gitDeployTool,
} from './git-deploy.js'
import * as auditModule from '../../security/audit.js'
import type { ToolContext } from '../types.js'

// ────────────────────────────────────────────────────────────────────────────
// Pure logic
// ────────────────────────────────────────────────────────────────────────────

describe('deriveBranchName', () => {
  it('slugifies the commit subject line', () => {
    expect(deriveBranchName('Fix orchestration init-project bug')).toBe(
      'agent/fix-orchestration-init-project-bug',
    )
  })

  it('uses only the first line of a multi-line commit message', () => {
    expect(deriveBranchName('Add X feature\n\nLonger description here')).toBe('agent/add-x-feature')
  })

  it('strips leading/trailing hyphens and double hyphens', () => {
    expect(deriveBranchName('   --Weird Subject!!! ')).toBe('agent/weird-subject')
  })

  it('caps the slug length at 50 chars', () => {
    const long = 'a '.repeat(40).trim()
    const branch = deriveBranchName(long)
    expect(branch.length).toBeLessThanOrEqual('agent/'.length + 50)
    expect(branch.startsWith('agent/')).toBe(true)
  })

  it('falls back to timestamp slug when subject yields empty slug', () => {
    const b = deriveBranchName('!!!')
    expect(b).toMatch(/^agent\/push-\d+$/)
  })
})

describe('formatApprovalPrompt', () => {
  it('shows branch + commit subject + stats + PR metadata', () => {
    const out = formatApprovalPrompt({
      branch: 'agent/foo',
      commitMessage: 'Add foo\n\nDetails…',
      prTitle: 'Add foo feature',
      prBody: 'This adds foo.',
      diffStat: ' src/foo.ts | 10 ++++\n 1 file changed',
      fileCount: 1,
    })
    expect(out).toContain('**Branch:** agent/foo')
    expect(out).toContain('**Commit:** Add foo')
    expect(out).toContain('**Files changed:** 1')
    expect(out).toContain('**PR title:** Add foo feature')
    expect(out).toContain('This adds foo.')
    expect(out).not.toContain('DIRECT PUSH TO MAIN')
  })

  it('warns prominently when branch is main', () => {
    const out = formatApprovalPrompt({
      branch: 'main',
      commitMessage: 'Direct fix',
      prTitle: 'n/a',
      prBody: 'n/a',
      diffStat: '',
      fileCount: 1,
    })
    expect(out).toContain('DIRECT PUSH TO MAIN')
  })

  it('warns when branch is master too', () => {
    const out = formatApprovalPrompt({
      branch: 'master',
      commitMessage: 'x',
      prTitle: 'x',
      prBody: 'x',
      diffStat: '',
      fileCount: 0,
    })
    expect(out).toContain('DIRECT PUSH TO MAIN')
  })

  it('truncates long PR body to 500 chars with ellipsis', () => {
    const longBody = 'x'.repeat(800)
    const out = formatApprovalPrompt({
      branch: 'agent/foo',
      commitMessage: 'x',
      prTitle: 'x',
      prBody: longBody,
      diffStat: '',
      fileCount: 0,
    })
    expect(out).toContain('…')
    expect(out).not.toContain('x'.repeat(800))
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Tool dispatch — integration via real temp git repo + stubbed askUser + stubbed gh
// ────────────────────────────────────────────────────────────────────────────

describe('gitDeployTool', () => {
  let tempDir: string
  let auditSpy: ReturnType<typeof spyOn>
  let auditCalls: auditModule.AuditEntry[]

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kc-git-deploy-'))
    await runCmd('git', ['init'], tempDir)
    await runCmd('git', ['config', 'user.email', 't@t.com'], tempDir)
    await runCmd('git', ['config', 'user.name', 'test'], tempDir)
    // Seed with one commit so HEAD is valid
    await writeFile(join(tempDir, 'seed.txt'), 'seed\n')
    await runCmd('git', ['add', '-A'], tempDir)
    await runCmd('git', ['commit', '-m', 'seed'], tempDir)

    auditCalls = []
    auditSpy = spyOn(auditModule, 'appendAuditEntry').mockImplementation(
      async (entry: auditModule.AuditEntry) => {
        auditCalls.push(entry)
      },
    )
  })

  afterEach(async () => {
    auditSpy.mockRestore()
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
    return {
      cwd: tempDir,
      toolTimeoutMs: 30_000,
      askUser: async () => 'yes',
      sessionId: 'git-deploy-test',
      ...overrides,
    }
  }

  it('returns an error when cwd is not a git repo', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'kc-not-repo-'))
    try {
      const result = await gitDeployTool.execute(
        { commitMessage: 'x', prTitle: 'x', prBody: 'x' },
        { ...makeCtx(), cwd: notRepo },
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('not a git repository')
    } finally {
      await rm(notRepo, { recursive: true, force: true })
    }
  })

  it('errors when there are no uncommitted changes', async () => {
    const result = await gitDeployTool.execute(
      { commitMessage: 'x', prTitle: 'x', prBody: 'x' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('no uncommitted changes')
  })

  it('rejects when the user answers "no" and writes a rejected audit entry', async () => {
    await writeFile(join(tempDir, 'change.txt'), 'change\n')

    const result = await gitDeployTool.execute(
      { commitMessage: 'Add change', prTitle: 't', prBody: 'b' },
      makeCtx({ askUser: async () => 'no' }),
    )

    expect(result.isError).toBe(false)
    expect(result.content).toContain('user rejected')

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].kind).toBe('git_deploy')
    expect(auditCalls[0].outcome).toBe('rejected')
    expect(auditCalls[0].branch).toBe('agent/add-change')
  })

  it('records a prompt_error audit entry when askUser throws', async () => {
    await writeFile(join(tempDir, 'c.txt'), 'x\n')
    const result = await gitDeployTool.execute(
      { commitMessage: 'Add c', prTitle: 't', prBody: 'b' },
      makeCtx({
        askUser: async () => {
          throw new Error('transport unavailable')
        },
      }),
    )
    expect(result.isError).toBe(true)
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].outcome).toBe('prompt_error')
  })

  it('uses the provided branch when specified, overriding derivation', async () => {
    await writeFile(join(tempDir, 'branch.txt'), 'x\n')

    const result = await gitDeployTool.execute(
      {
        commitMessage: 'Anything',
        prTitle: 't',
        prBody: 'b',
        branch: 'custom/specific-branch',
      },
      makeCtx({ askUser: async () => 'no' }),
    )

    expect(result.isError).toBe(false)
    expect(auditCalls[0].branch).toBe('custom/specific-branch')
  })

  it('surfaces askUser prompt content with the full metadata', async () => {
    await writeFile(join(tempDir, 'prompt.txt'), 'x\n')

    let capturedPrompt = ''
    const ctx = makeCtx({
      askUser: async (question) => {
        capturedPrompt = question
        return 'no'
      },
    })

    await gitDeployTool.execute(
      {
        commitMessage: 'Fix the bug',
        prTitle: 'Fix the bug PR',
        prBody: 'This fixes the reported bug.',
      },
      ctx,
    )

    expect(capturedPrompt).toContain('**Branch:** agent/fix-the-bug')
    expect(capturedPrompt).toContain('**Commit:** Fix the bug')
    expect(capturedPrompt).toContain('**PR title:** Fix the bug PR')
    expect(capturedPrompt).toContain('This fixes the reported bug.')
  })

  it('schema rejects empty commit messages', async () => {
    const result = await gitDeployTool.execute(
      { commitMessage: '', prTitle: 't', prBody: 'b' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Invalid')
  })
})
