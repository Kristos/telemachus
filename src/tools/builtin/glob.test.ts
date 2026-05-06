import { describe, it, expect } from 'bun:test'
import path from 'node:path'
import { globTool } from './glob.js'
import type { ToolContext } from '../types.js'

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const ctx: ToolContext = { cwd: repoRoot, toolTimeoutMs: 30000, askUser: async () => '' }

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return { ...ctx, ...over }
}

describe('glob tool path handling', () => {
  it('forward-slash glob patterns work on all platforms (minimatch convention)', async () => {
    const res = await globTool.execute(
      { pattern: 'src/tools/builtin/*.ts' },
      ctx
    )
    expect(res.isError).toBe(false)
    expect(res.content).toContain('glob.ts')
    expect(res.content).toContain('grep.ts')
  })

  it('base path built with path.sep / path.join resolves correctly', async () => {
    const base = path.join(repoRoot, 'src', 'tools', 'builtin')
    const res = await globTool.execute({ pattern: '*.ts', path: base }, ctx)
    expect(res.isError).toBe(false)
    expect(res.content).toContain('glob.ts')
  })

  it('absolute path via path.resolve (cross-platform) returns expected results', async () => {
    const abs = path.resolve(__dirname)
    const res = await globTool.execute({ pattern: '*.ts', path: abs }, ctx)
    expect(res.isError).toBe(false)
    expect(res.content).toContain('grep.ts')
  })
})

describe('glob SAND-05 regression (Phase 62, 999.15)', () => {
  it("refuses filesystem-root basePath '/' with descriptive error", async () => {
    const res = await globTool.execute({ pattern: '**/*', path: '/' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.content).toContain('SAND-05')
    expect(res.content.toLowerCase()).toContain('filesystem root')
  })

  it('refuses empty basePath with descriptive error', async () => {
    const res = await globTool.execute(
      { pattern: '**/*' },
      makeCtx({ cwd: '' }),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toContain('SAND-05')
  })

  it('filters out /dev/fd paths when pattern targets them', async () => {
    // Use /dev as basePath with fd targeted — pre-fix this produced EBADF.
    // Post-fix the glob runs successfully; either matches are filtered out
    // or the scan completes with a structured result.
    const res = await globTool.execute(
      { pattern: 'fd/*', path: '/dev' },
      ctx,
    )
    // Either: (a) no matches found (filtered), or (b) isError:false with
    // zero /dev/fd/ paths in content. Both mean "no EBADF leaked to user".
    if (res.isError) {
      // If an error did leak, it must carry the triage hint
      expect(res.content).toContain('SAND-05')
    } else {
      // If no error, results must not include transient fd paths
      expect(res.content).not.toContain('/dev/fd/')
    }
  })

  it('happy path unchanged — normal repo scan still works', async () => {
    const res = await globTool.execute({ pattern: 'src/tools/builtin/*.ts' }, ctx)
    expect(res.isError).toBe(false)
    expect(res.content).toContain('glob.ts')
  })
})
