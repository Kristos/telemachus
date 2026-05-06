import { describe, test, expect } from 'bun:test'
import { getPlatformSandbox } from './index.js'

describe('platform sandbox dispatcher', () => {
  test('returns a PlatformSandbox object with required fields', () => {
    const s = getPlatformSandbox()
    expect(typeof s.available).toBe('boolean')
    expect(typeof s.wrap).toBe('function')
    expect(typeof s.detect).toBe('function')
  })

  test('available matches platform', () => {
    const s = getPlatformSandbox()
    expect(s.available).toBe(process.platform === 'darwin')
  })

  test('wrap on non-darwin passes through unchanged', () => {
    if (process.platform === 'darwin') {
      // on darwin this is tested in macos.test.ts
      return
    }
    const s = getPlatformSandbox()
    const out = s.wrap('bash', ['-c', 'ls'], {
      network: false,
      cwd: process.cwd(),
      tmpdir: '/tmp/kc-test',
    })
    expect(out).toEqual(['bash', '-c', 'ls'])
  })

  test('wrap on darwin injects sandbox-exec', () => {
    if (process.platform !== 'darwin') return
    const s = getPlatformSandbox()
    const out = s.wrap('bash', ['-c', 'ls'], {
      network: false,
      cwd: process.cwd(),
      tmpdir: '/private/tmp/kc-test',
    })
    expect(out[0]).toBe('sandbox-exec')
  })

  test('detect resolves to false on non-darwin', async () => {
    if (process.platform === 'darwin') return
    const s = getPlatformSandbox()
    expect(await s.detect()).toBe(false)
  })
})
