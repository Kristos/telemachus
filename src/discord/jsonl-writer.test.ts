/**
 * Phase 65 (HYG-03): Tests for JsonlWriter — mkdir → open → appendFile →
 * datasync → close pipeline extracted from usage-store, turn-summary-store,
 * token-budget.
 *
 * Key invariants:
 *   - Creates the target directory if it does not exist.
 *   - Calls datasync() on the FileHandle before closing.
 *   - Concurrent appends produce whole, intact lines (O_APPEND atomicity).
 *   - Errors are caught and routed to log.warn — append() never throws.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm, open as fsOpen } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlWriter } from './jsonl-writer.js'
import * as logger from '../log/logger.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kc-jsonl-writer-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('JsonlWriter.append', () => {
  it('writes one JSON line to the resolved path with trailing newline', async () => {
    const targetDir = join(tmpDir, 'writes')
    const writer = new JsonlWriter({
      resolveDir: () => targetDir,
      resolvePath: () => join(targetDir, 'today.jsonl'),
      module: 'test',
    })

    await writer.append({ ts: '2026-04-20T00:00:00Z', foo: 'bar' })

    const content = await readFile(join(targetDir, 'today.jsonl'), 'utf8')
    expect(content).toBe('{"ts":"2026-04-20T00:00:00Z","foo":"bar"}\n')
  })

  it('creates the target directory recursively if missing', async () => {
    const deepDir = join(tmpDir, 'a', 'b', 'c')
    const writer = new JsonlWriter({
      resolveDir: () => deepDir,
      resolvePath: () => join(deepDir, 'records.jsonl'),
      module: 'test',
    })

    await writer.append({ ts: '2026-04-20T00:00:00Z', n: 1 })

    const content = await readFile(join(deepDir, 'records.jsonl'), 'utf8')
    expect(JSON.parse(content.trim())).toEqual({ ts: '2026-04-20T00:00:00Z', n: 1 })
  })

  it('invokes FileHandle.datasync() before close', async () => {
    // Spy on fs.promises.open so we can capture the returned FileHandle
    // and spy on its datasync/close methods.
    const datasyncCalls: number[] = []
    const closeCalls: number[] = []
    const originalOpen = fsOpen
    const openSpy = spyOn(await import('node:fs/promises'), 'open').mockImplementation(
      async (path: Parameters<typeof originalOpen>[0], flags?: Parameters<typeof originalOpen>[1]) => {
        const fh = await originalOpen(path, flags)
        const originalDatasync = fh.datasync.bind(fh)
        const originalClose = fh.close.bind(fh)
        fh.datasync = async () => {
          datasyncCalls.push(Date.now())
          return originalDatasync()
        }
        fh.close = async () => {
          closeCalls.push(Date.now())
          return originalClose()
        }
        return fh
      },
    )

    try {
      const targetDir = join(tmpDir, 'dsync')
      const writer = new JsonlWriter({
        resolveDir: () => targetDir,
        resolvePath: () => join(targetDir, 'sync.jsonl'),
        module: 'test',
      })
      await writer.append({ ts: '2026-04-20T00:00:00Z', ok: true })

      expect(datasyncCalls.length).toBe(1)
      expect(closeCalls.length).toBe(1)
      // datasync before close
      expect(datasyncCalls[0]!).toBeLessThanOrEqual(closeCalls[0]!)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('closes the FileHandle even when appendFile throws', async () => {
    const closeCalls: number[] = []
    const originalOpen = fsOpen
    const openSpy = spyOn(await import('node:fs/promises'), 'open').mockImplementation(
      async (path: Parameters<typeof originalOpen>[0], flags?: Parameters<typeof originalOpen>[1]) => {
        const fh = await originalOpen(path, flags)
        const originalClose = fh.close.bind(fh)
        fh.appendFile = async () => { throw new Error('simulated disk full') }
        fh.close = async () => {
          closeCalls.push(1)
          return originalClose()
        }
        return fh
      },
    )

    try {
      const targetDir = join(tmpDir, 'close-on-throw')
      const writer = new JsonlWriter({
        resolveDir: () => targetDir,
        resolvePath: () => join(targetDir, 'x.jsonl'),
        module: 'test',
      })

      // append() must never throw even though appendFile does.
      await writer.append({ ts: '2026-04-20T00:00:00Z', ok: false })

      expect(closeCalls.length).toBe(1)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('concurrent appends produce N intact JSON lines (O_APPEND atomicity)', async () => {
    const targetDir = join(tmpDir, 'concurrent')
    const writer = new JsonlWriter({
      resolveDir: () => targetDir,
      resolvePath: () => join(targetDir, 'parallel.jsonl'),
      module: 'test',
    })

    const N = 50
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writer.append({
          ts: new Date().toISOString(),
          seq: i,
          payload: 'A'.repeat(200 + i),  // variable length exposes byte interleave
        }),
      ),
    )

    const content = await readFile(join(targetDir, 'parallel.jsonl'), 'utf8')
    const lines = content.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(N)

    // Each line must be parseable as JSON AND have a seq field
    const seqs = new Set<number>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as { seq: number }
      expect(typeof parsed.seq).toBe('number')
      seqs.add(parsed.seq)
    }
    // All seqs are distinct and cover the full range (no corruption)
    expect(seqs.size).toBe(N)
  })

  it('errors routed to log.warn with module + warnContext fields; append never throws', async () => {
    const warnSpy = spyOn(logger, 'log').mockImplementation(() => {})

    const writer = new JsonlWriter({
      // Force mkdir failure by resolving to a path with a file as parent
      resolveDir: () => '/nonexistent-root-12345/subdir',
      resolvePath: () => '/nonexistent-root-12345/subdir/x.jsonl',
      module: 'test-module',
      warnContext: (r) => ({ userId: (r as { userId: string }).userId }),
    })

    // Must not throw even though mkdir will fail
    await writer.append({ ts: '2026-04-20T00:00:00Z', userId: 'abc-123' })

    // log.warn should have been called with module + userId from warnContext
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0)
    const [level, fields, msg] = warnSpy.mock.calls[warnSpy.mock.calls.length - 1]! as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(level).toBe('warn')
    expect(fields['module']).toBe('test-module')
    expect(fields['userId']).toBe('abc-123')
    expect(fields['error']).toBeDefined()
    expect(typeof msg).toBe('string')

    warnSpy.mockRestore()
  })
})
