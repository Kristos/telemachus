import { describe, expect, test } from 'bun:test'
import { runHooks } from './runner'
import type { HookCommand } from './types'

const cmd = (command: string, timeout?: number): HookCommand => ({ type: 'command', command, timeout })

describe('runHooks', () => {
  test('empty commands returns []', async () => {
    const r = await runHooks('PreToolUse', 'Bash', [])
    expect(r).toEqual([])
  })

  test('successful command captures stdout, exitCode 0, not blocked', async () => {
    const r = await runHooks('PreToolUse', 'Bash', [cmd('echo hi')])
    expect(r).toHaveLength(1)
    expect(r[0].exitCode).toBe(0)
    expect(r[0].stdout).toContain('hi')
    expect(r[0].blocked).toBe(false)
    expect(r[0].timedOut).toBe(false)
  })

  test('failing PreToolUse command blocks', async () => {
    const r = await runHooks('PreToolUse', 'Bash', [cmd('exit 1')])
    expect(r[0].exitCode).toBe(1)
    expect(r[0].blocked).toBe(true)
  })

  test('failing PostToolUse never blocks', async () => {
    const r = await runHooks('PostToolUse', 'Bash', [cmd('exit 1')])
    expect(r[0].exitCode).toBe(1)
    expect(r[0].blocked).toBe(false)
  })

  test('failing Stop never blocks', async () => {
    const r = await runHooks('Stop', 'Bash', [cmd('exit 1')])
    expect(r[0].exitCode).toBe(1)
    expect(r[0].blocked).toBe(false)
  })

  test('command exceeding timeout is killed and blocks on PreToolUse', async () => {
    const start = Date.now()
    const r = await runHooks('PreToolUse', 'Bash', [cmd('sleep 2', 0.1)])
    const elapsed = Date.now() - start
    expect(r[0].timedOut).toBe(true)
    expect(r[0].blocked).toBe(true)
    expect(elapsed).toBeLessThan(3000)
  })

  test('multiple commands run sequentially even if first blocks', async () => {
    const r = await runHooks('PreToolUse', 'Bash', [cmd('exit 1'), cmd('echo second')])
    expect(r).toHaveLength(2)
    expect(r[0].blocked).toBe(true)
    expect(r[1].stdout).toContain('second')
    expect(r[1].exitCode).toBe(0)
  })

  test('spawn failure is captured, not thrown', async () => {
    const r = await runHooks('PreToolUse', 'Bash', [cmd('/no/such/cmd/definitely-missing-xyz')])
    expect(r).toHaveLength(1)
    expect(r[0].exitCode).not.toBe(0)
    expect(r[0].stderr.length).toBeGreaterThan(0)
  })
})
