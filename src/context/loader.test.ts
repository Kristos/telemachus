/**
 * Phase 46 (CTX-01, CTX-02, CTX-04): Tests for the shared context loader.
 *
 * Hierarchy:
 *   1. {homedir}/.claude/CLAUDE.md  — global
 *   2. {cwd}/.claude/CLAUDE.md      — project
 *   3. {cwd}/CLAUDE.md              — local
 *   Fallback: {cwd}/AGENTS.md       — if no CLAUDE.md found
 *   Memory: {cwd}/KC_MEMORY.md preferred, {cwd}/MEMORY.md fallback
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSharedContext } from './loader.js'

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kc-ctx-test-'))
}

describe('loadSharedContext', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  async function tmpDir(): Promise<string> {
    const d = await makeTmp()
    dirs.push(d)
    return d
  }

  it('returns empty result when no context files exist', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(0)
    expect(result.systemPromptPrefix).toBe('')
    expect(result.totalBytes).toBe(0)
    expect(result.budgetWarning).toBeNull()
  })

  it('loads global CLAUDE.md from {homedir}/.claude/CLAUDE.md', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(homedir, '.claude'))
    await writeFile(join(homedir, '.claude', 'CLAUDE.md'), 'Global instructions here')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].source).toBe('global')
    expect(result.files[0].content).toBe('Global instructions here')
    expect(result.systemPromptPrefix).toContain('Global instructions here')
  })

  it('loads project CLAUDE.md from {cwd}/.claude/CLAUDE.md', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(cwd, '.claude'))
    await writeFile(join(cwd, '.claude', 'CLAUDE.md'), 'Project-level instructions')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].source).toBe('project')
    expect(result.files[0].content).toBe('Project-level instructions')
  })

  it('loads local CLAUDE.md from {cwd}/CLAUDE.md', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'CLAUDE.md'), 'Local workspace instructions')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].source).toBe('local')
    expect(result.files[0].content).toBe('Local workspace instructions')
  })

  it('loads all three CLAUDE.md levels in order: global, project, local', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(homedir, '.claude'))
    await mkdir(join(cwd, '.claude'))
    await writeFile(join(homedir, '.claude', 'CLAUDE.md'), 'GLOBAL')
    await writeFile(join(cwd, '.claude', 'CLAUDE.md'), 'PROJECT')
    await writeFile(join(cwd, 'CLAUDE.md'), 'LOCAL')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(3)
    expect(result.files[0].source).toBe('global')
    expect(result.files[1].source).toBe('project')
    expect(result.files[2].source).toBe('local')

    // Global comes first in systemPromptPrefix
    const idx0 = result.systemPromptPrefix.indexOf('GLOBAL')
    const idx1 = result.systemPromptPrefix.indexOf('PROJECT')
    const idx2 = result.systemPromptPrefix.indexOf('LOCAL')
    expect(idx0).toBeLessThan(idx1)
    expect(idx1).toBeLessThan(idx2)
  })

  it('loads AGENTS.md as fallback when no CLAUDE.md found', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'AGENTS.md'), 'Agents fallback content')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].source).toBe('local')
    expect(result.files[0].content).toBe('Agents fallback content')
    expect(result.files[0].label).toContain('AGENTS.md')
  })

  it('does NOT load AGENTS.md when CLAUDE.md is present', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'CLAUDE.md'), 'Local workspace instructions')
    await writeFile(join(cwd, 'AGENTS.md'), 'Agents fallback content')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].content).toBe('Local workspace instructions')
  })

  it('loads KC_MEMORY.md as memory file (preferred)', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'KC_MEMORY.md'), 'KC memory content')
    await writeFile(join(cwd, 'MEMORY.md'), 'Generic memory content')

    const result = await loadSharedContext({ cwd, homedir })
    const memFiles = result.files.filter(f => f.source === 'memory')
    expect(memFiles).toHaveLength(1)
    expect(memFiles[0].content).toBe('KC memory content')
    expect(memFiles[0].label).toContain('KC_MEMORY.md')
  })

  it('falls back to MEMORY.md when KC_MEMORY.md is absent', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'MEMORY.md'), 'Generic memory content')

    const result = await loadSharedContext({ cwd, homedir })
    const memFiles = result.files.filter(f => f.source === 'memory')
    expect(memFiles).toHaveLength(1)
    expect(memFiles[0].content).toBe('Generic memory content')
    expect(memFiles[0].label).toContain('MEMORY.md')
  })

  it('returns no memory file when neither KC_MEMORY.md nor MEMORY.md exists', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()

    const result = await loadSharedContext({ cwd, homedir })
    const memFiles = result.files.filter(f => f.source === 'memory')
    expect(memFiles).toHaveLength(0)
  })

  it('calculates estimatedTokens as Math.ceil(bytes / 4)', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    const content = 'Hello world!'  // 12 bytes → ceil(12/4) = 3
    await writeFile(join(cwd, 'CLAUDE.md'), content)

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files[0].bytes).toBe(12)
    expect(result.files[0].estimatedTokens).toBe(3)
  })

  it('includes section headers in systemPromptPrefix', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'CLAUDE.md'), 'Local content')

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.systemPromptPrefix).toContain('--- Project Context')
    expect(result.systemPromptPrefix).toContain('CLAUDE.md')
    expect(result.systemPromptPrefix).toContain('Local content')
  })

  it('emits budgetWarning and writes to stderr when total tokens exceed budget', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    // Create a large content that exceeds the small token budget
    const bigContent = 'A'.repeat(400)  // 400 bytes / 4 = 100 tokens
    await writeFile(join(cwd, 'CLAUDE.md'), bigContent)

    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const result = await loadSharedContext({ cwd, homedir, tokenBudget: 50 })
      expect(result.budgetWarning).not.toBeNull()
      expect(result.budgetWarning).toContain('tokens')
      expect(result.budgetWarning).toContain('50')
      // stderr should have been called with the warning
      const stderrCalls = stderrSpy.mock.calls
      const warningWritten = stderrCalls.some(call =>
        typeof call[0] === 'string' && call[0].includes('tokens')
      )
      expect(warningWritten).toBe(true)
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('does not emit budgetWarning when within budget', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'CLAUDE.md'), 'Short content')

    const result = await loadSharedContext({ cwd, homedir, tokenBudget: 8000 })
    expect(result.budgetWarning).toBeNull()
  })

  it('reports correct totalBytes and totalEstimatedTokens', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(homedir, '.claude'))
    await writeFile(join(homedir, '.claude', 'CLAUDE.md'), 'AAAA')  // 4 bytes
    await writeFile(join(cwd, 'CLAUDE.md'), 'BBBBBBBB')              // 8 bytes

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.totalBytes).toBe(12)
    expect(result.totalEstimatedTokens).toBe(3)  // ceil(12/4)
  })

  // ────────────────────────────────────────────────────────────────────────
  // Phase 67 (AGMEM-01..03): per-agent memory tests
  // ────────────────────────────────────────────────────────────────────────

  it('loads per-agent memory at {homedir}/.telemachus/agent-memory/<agentName>/MEMORY.md when agentName provided', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(homedir, '.telemachus', 'agent-memory', 'test-agent'), { recursive: true })
    await writeFile(
      join(homedir, '.telemachus', 'agent-memory', 'test-agent', 'MEMORY.md'),
      'AGENT_MARKER',
    )

    const result = await loadSharedContext({ cwd, homedir, agentName: 'test-agent' })

    const agentFiles = result.files.filter(f => f.source === 'agent')
    expect(agentFiles).toHaveLength(1)
    expect(agentFiles[0].content).toBe('AGENT_MARKER')
    expect(agentFiles[0].label).toBe('agent:test-agent')
    expect(result.systemPromptPrefix).toContain('AGENT_MARKER')
  })

  it('appends per-agent memory AFTER KC_MEMORY.md (later = more specific)', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await writeFile(join(cwd, 'KC_MEMORY.md'), 'GLOBAL_MEM')
    await mkdir(join(homedir, '.telemachus', 'agent-memory', 'x'), { recursive: true })
    await writeFile(
      join(homedir, '.telemachus', 'agent-memory', 'x', 'MEMORY.md'),
      'AGENT_MEM',
    )

    const result = await loadSharedContext({ cwd, homedir, agentName: 'x' })

    const idxGlobal = result.systemPromptPrefix.indexOf('GLOBAL_MEM')
    const idxAgent = result.systemPromptPrefix.indexOf('AGENT_MEM')
    expect(idxGlobal).toBeGreaterThanOrEqual(0)
    expect(idxAgent).toBeGreaterThanOrEqual(0)
    expect(idxGlobal).toBeLessThan(idxAgent)

    // Last entry must be the per-agent file
    const last = result.files[result.files.length - 1]
    expect(last.source).toBe('agent')
  })

  it('silently skips missing per-agent memory file', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    // No agent memory on disk; also no other context files
    const result = await loadSharedContext({ cwd, homedir, agentName: 'ghost' })
    expect(result.files).toHaveLength(0)
    expect(result.systemPromptPrefix).toBe('')
  })

  it('per-agent memory participates in totalBytes / totalEstimatedTokens / budgetWarning', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    await mkdir(join(homedir, '.telemachus', 'agent-memory', 'big'), { recursive: true })
    await writeFile(
      join(homedir, '.telemachus', 'agent-memory', 'big', 'MEMORY.md'),
      'A'.repeat(400), // 400 bytes → 100 tokens
    )

    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = await loadSharedContext({
        cwd,
        homedir,
        agentName: 'big',
        tokenBudget: 50,
      })
      expect(result.totalBytes).toBe(400)
      expect(result.totalEstimatedTokens).toBe(100)
      expect(result.budgetWarning).not.toBeNull()
      expect(result.budgetWarning).toContain('50')
      expect(result.budgetWarning).toContain('100')
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('calling without agentName is backward-compatible (zero files entries from agent-memory)', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    // Write a per-agent MEMORY.md that would be loaded if agentName was passed
    await mkdir(join(homedir, '.telemachus', 'agent-memory', 'unused'), { recursive: true })
    await writeFile(
      join(homedir, '.telemachus', 'agent-memory', 'unused', 'MEMORY.md'),
      'SHOULD_NOT_APPEAR',
    )

    const result = await loadSharedContext({ cwd, homedir })
    expect(result.files).toHaveLength(0)
    expect(result.systemPromptPrefix).toBe('')
  })

  it('loads per-agent memory using a job name convention (AGMEM-03)', async () => {
    const cwd = await tmpDir()
    const homedir = await tmpDir()
    const jobName = 'nightly-job'
    await mkdir(join(homedir, '.telemachus', 'agent-memory', jobName), { recursive: true })
    await writeFile(
      join(homedir, '.telemachus', 'agent-memory', jobName, 'MEMORY.md'),
      'SCRAPER_NOTES',
    )

    const result = await loadSharedContext({ cwd, homedir, agentName: jobName })
    expect(result.systemPromptPrefix).toContain('SCRAPER_NOTES')
    const agentFile = result.files.find(f => f.source === 'agent')
    expect(agentFile).toBeDefined()
    expect(agentFile?.label).toBe(`agent:${jobName}`)
  })
})
