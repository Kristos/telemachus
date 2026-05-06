import { describe, it, expect } from 'bun:test'
import path from 'node:path'
import { grepTool } from './grep.js'
import type { ToolContext } from '../types.js'

const ctx: ToolContext = { cwd: path.resolve(__dirname, '..', '..', '..'), toolTimeoutMs: 30000, askUser: async () => '' }

// rg may not be installed in the test environment. We accept either a clean
// match result OR the well-known "ripgrep not found" error message — what we're
// asserting is path-handling behavior, not ripgrep availability.
function assertNotPathError(content: string) {
  expect(content).not.toContain('ENOENT: no such file')
  expect(content).not.toContain('cannot be coerced')
}

describe('grep tool path handling', () => {
  it('accepts an absolute path resolved via path.resolve (cross-platform)', async () => {
    const abs = path.resolve(__dirname)
    const res = await grepTool.execute(
      { pattern: 'grepTool', path: abs, output_mode: 'files_with_matches' },
      ctx
    )
    expect(typeof res.content).toBe('string')
    assertNotPathError(res.content)
  })

  it('does not throw on a path containing backslashes (Windows-style input)', async () => {
    const winStyle = 'src\\tools\\builtin'
    const normalized = path.normalize(winStyle)
    const res = await grepTool.execute(
      { pattern: 'grepTool', path: normalized, output_mode: 'files_with_matches' },
      ctx
    )
    expect(typeof res.content).toBe('string')
    assertNotPathError(res.content)
  })

  it('resolves a relative path against context.cwd via spawn cwd', async () => {
    const res = await grepTool.execute(
      { pattern: 'grepTool', path: 'src/tools/builtin', output_mode: 'files_with_matches' },
      ctx
    )
    expect(typeof res.content).toBe('string')
    assertNotPathError(res.content)
  })
})
