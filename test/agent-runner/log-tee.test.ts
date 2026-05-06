import { describe, test, expect, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startLogTee, stopLogTee } from '../../src/agent-runner/log-tee.js'

const tempFiles: string[] = []

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(f)
    } catch {}
  }
})

function tempPath(): string {
  const p = path.join(os.tmpdir(), `kc-logtee-${Date.now()}-${Math.random()}.log`)
  tempFiles.push(p)
  return p
}

describe('log-tee (Phase 22-01)', () => {
  test('tees stdout and stderr to file while preserving real streams', () => {
    const file = tempPath()

    // Capture real stdout BEFORE tee starts so we can prove pass-through.
    const captured: string[] = []
    const origOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      // Forward to the real stream so the test runner still works.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origOut as any)(chunk, ...rest)
    }) as typeof process.stdout.write

    try {
      const handle = startLogTee(file)
      try {
        process.stdout.write('hello\n')
        process.stderr.write('world\n')
      } finally {
        stopLogTee(handle)
      }
    } finally {
      process.stdout.write = origOut
    }

    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('hello')
    expect(content).toContain('world')

    // Pass-through: the pre-tee captor saw 'hello\n'.
    const joined = captured.join('')
    expect(joined).toContain('hello')
  })

  test('nested start/stop restores the prior wrapper (not the pristine original)', () => {
    const outerFile = tempPath()
    const innerFile = tempPath()

    const outer = startLogTee(outerFile)
    const inner = startLogTee(innerFile)
    process.stdout.write('both\n')
    stopLogTee(inner)
    // After inner stop, outer tee should still be active.
    process.stdout.write('outer-only\n')
    stopLogTee(outer)

    const outerContent = fs.readFileSync(outerFile, 'utf8')
    const innerContent = fs.readFileSync(innerFile, 'utf8')

    expect(outerContent).toContain('both')
    expect(outerContent).toContain('outer-only')
    expect(innerContent).toContain('both')
    expect(innerContent).not.toContain('outer-only')
  })

  test('stop() restores originals so later writes do not hit the file', () => {
    const file = tempPath()
    const handle = startLogTee(file)
    process.stdout.write('before-stop\n')
    stopLogTee(handle)
    process.stdout.write('after-stop\n')

    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('before-stop')
    expect(content).not.toContain('after-stop')
  })
})
