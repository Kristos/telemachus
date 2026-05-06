import { describe, it, expect } from 'bun:test'
import { selectShell } from './bash.js'
import { buildBashInvocation } from './bash.js'
import type { ToolContext } from '../types.js'

describe('selectShell', () => {
  it('darwin defaults to bash -c', () => {
    const sel = selectShell('darwin', {})
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('bash')
    expect(sel.buildArgs('echo hi')).toEqual(['-c', 'echo hi'])
  })

  it('linux defaults to bash -c', () => {
    const sel = selectShell('linux', {})
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('bash')
    expect(sel.buildArgs('ls')).toEqual(['-c', 'ls'])
  })

  it('win32 defaults to cmd /c', () => {
    const sel = selectShell('win32', {})
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('cmd')
    expect(sel.buildArgs('dir')).toEqual(['/c', 'dir'])
  })

  it('win32 with KC_SHELL=powershell uses powershell -Command', () => {
    const sel = selectShell('win32', { KC_SHELL: 'powershell' })
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('powershell')
    expect(sel.buildArgs('Get-ChildItem')).toEqual(['-Command', 'Get-ChildItem'])
  })

  it('win32 with KC_SHELL=cmd uses cmd /c', () => {
    const sel = selectShell('win32', { KC_SHELL: 'cmd' })
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('cmd')
    expect(sel.buildArgs('dir')).toEqual(['/c', 'dir'])
  })

  it('darwin with KC_SHELL=zsh uses zsh -c', () => {
    const sel = selectShell('darwin', { KC_SHELL: 'zsh' })
    if ('error' in sel) throw new Error('unexpected error')
    expect(sel.cmd).toBe('zsh')
    expect(sel.buildArgs('echo hi')).toEqual(['-c', 'echo hi'])
  })

  it('win32 with unsupported KC_SHELL returns WSL-suggesting error', () => {
    const sel = selectShell('win32', { KC_SHELL: 'fish' })
    if (!('error' in sel)) throw new Error('expected error')
    expect(sel.error).toMatch(/WSL/i)
    expect(sel.error).toMatch(/fish/)
  })
})

// --- buildBashInvocation tests ---

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    toolTimeoutMs: 30000,
    askUser: async () => '',
    sessionId: 'sess-1',
    mode: 'ask',
    sessionTmpdir: '/private/tmp/kc-sess-1',
    sandboxAvailable: true,
    ...over,
  }
}

describe('buildBashInvocation', () => {
  it('ask + sandbox available + darwin wraps with sandbox-exec', () => {
    if (process.platform !== 'darwin') return
    const { args, sandboxStatus, failClosed } = buildBashInvocation('ls', false, ctx())
    expect(args[0]).toBe('sandbox-exec')
    expect(sandboxStatus).toBe('enforced')
    expect(failClosed).toBe(false)
  })

  it('yolo + darwin bypasses (no sandbox-exec)', () => {
    if (process.platform !== 'darwin') return
    const { args, sandboxStatus } = buildBashInvocation('ls', false, ctx({ mode: 'yolo' }))
    expect(args[0]).not.toBe('sandbox-exec')
    expect(sandboxStatus).toBe('bypassed')
  })

  it('ask + sandbox unavailable on darwin is fail-closed', () => {
    if (process.platform !== 'darwin') return
    const { sandboxStatus, failClosed } = buildBashInvocation(
      'ls', false, ctx({ sandboxAvailable: false }),
    )
    expect(sandboxStatus).toBe('unavailable')
    expect(failClosed).toBe(true)
  })

  it('yolo + sandbox unavailable on darwin runs with UNAVAILABLE status', () => {
    if (process.platform !== 'darwin') return
    const { args, sandboxStatus, failClosed } = buildBashInvocation(
      'ls', false, ctx({ mode: 'yolo', sandboxAvailable: false }),
    )
    expect(args[0]).not.toBe('sandbox-exec')
    expect(sandboxStatus).toBe('unavailable')
    expect(failClosed).toBe(false)
  })

  it('non-darwin is n/a status, never fail-closed', () => {
    if (process.platform === 'darwin') return
    const { args, sandboxStatus, failClosed } = buildBashInvocation('ls', false, ctx())
    expect(args[0]).not.toBe('sandbox-exec')
    expect(sandboxStatus).toBe('n/a')
    expect(failClosed).toBe(false)
  })

  it('network=true on darwin propagates to sandbox profile arg', () => {
    if (process.platform !== 'darwin') return
    const { args } = buildBashInvocation('curl x', true, ctx())
    expect(args[0]).toBe('sandbox-exec')
    expect(args[2]).toContain('network-outbound')
  })

  it('KC_TMPDIR should be set from context.sessionTmpdir (verify args shape)', () => {
    if (process.platform !== 'darwin') return
    const { args } = buildBashInvocation('ls', false, ctx({ sessionTmpdir: '/private/tmp/kc-test' }))
    // On darwin the args are the sandbox-exec invocation
    // The profile (args[2]) contains TMPDIR param substitution
    expect(args.some(a => a.includes('/private/tmp/kc-test'))).toBe(true)
  })
})
