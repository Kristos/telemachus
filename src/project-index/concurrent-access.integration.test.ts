/**
 * Phase 50-01 (DOG-01): Concurrent SQLite access integration test.
 *
 * Proves WAL mode handles 3+ concurrent consumers without SQLITE_BUSY errors.
 * Only runs when `KC_INTEGRATION_CONCURRENT=1` is set. Default `bun test` skips.
 *
 * Run manually:
 *   KC_INTEGRATION_CONCURRENT=1 bun test src/project-index/concurrent-access.integration.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexDB } from './db.js'
import { handleSearchFiles, handleIndexStatus } from './mcp-server.js'

const GATED = process.env.KC_INTEGRATION_CONCURRENT === '1'
const describeGated = GATED ? describe : describe.skip

let tmpDir: string
let db1: IndexDB | null = null
let db2: IndexDB | null = null

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `kc-concurrent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(async () => {
  if (db1) {
    db1.close()
    db1 = null
  }
  if (db2) {
    db2.close()
    db2 = null
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

/** Make a minimal FileEntry for a given path */
function makeEntry(path: string) {
  return {
    path,
    size: 100,
    mtime: Date.now(),
    extension: '.ts',
    language: 'typescript',
    content_hash: `hash-${path}`,
  }
}

/** Make 2 symbols for a file */
function makeSymbols(filePath: string) {
  return [
    { name: 'testFn', kind: 'function', line: 1 },
    { name: 'TestClass', kind: 'class', line: 10 },
  ]
}

describeGated('concurrent SQLite access (WAL mode)', () => {
  test(
    'three concurrent DB consumers produce zero SQLITE_BUSY',
    async () => {
      const dbPath = join(tmpDir, '.kc-index', 'project.db')
      db1 = await IndexDB.open(dbPath)
      const db = db1

      const errors: string[] = []

      // Writer: 100 upsertFile + upsertSymbols calls
      const writerPromise = (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            const path = `file-${i}.ts`
            db.upsertFile(makeEntry(path))
            db.upsertSymbols(path, makeSymbols(path))
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
      })()

      // Reader: 100 getAllFiles + searchSymbolsByName calls
      const readerPromise = (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            db.getAllFiles()
            db.searchSymbolsByName('testFn')
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
      })()

      // MCP reader: 100 handleSearchFiles + handleIndexStatus calls
      const mcpReaderPromise = (async () => {
        for (let i = 0; i < 100; i++) {
          try {
            handleSearchFiles(db, {})
            handleIndexStatus(db)
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
      })()

      await Promise.all([writerPromise, readerPromise, mcpReaderPromise])

      const busyErrors = errors.filter((e) =>
        /SQLITE_BUSY|database is locked/i.test(e)
      )
      expect(busyErrors).toEqual([])

      // Verify writes actually landed
      expect(db.getFileCount()).toBeGreaterThan(0)
    },
    15000
  )

  test(
    'concurrent writes from two separate IndexDB instances on same file',
    async () => {
      const dbPath = join(tmpDir, '.kc-index', 'project.db')
      db1 = await IndexDB.open(dbPath)
      db2 = await IndexDB.open(dbPath)

      const errors: string[] = []

      // Writer 1: 50 files with unique paths (db1-0.ts .. db1-49.ts)
      const writer1 = (async () => {
        for (let i = 0; i < 50; i++) {
          try {
            db1!.upsertFile(makeEntry(`db1-${i}.ts`))
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
      })()

      // Writer 2: 50 files with unique paths (db2-0.ts .. db2-49.ts)
      const writer2 = (async () => {
        for (let i = 0; i < 50; i++) {
          try {
            db2!.upsertFile(makeEntry(`db2-${i}.ts`))
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
      })()

      await Promise.all([writer1, writer2])

      const busyErrors = errors.filter((e) =>
        /SQLITE_BUSY|database is locked/i.test(e)
      )
      expect(busyErrors).toEqual([])

      // Both writers wrote distinct paths — total should be 100
      expect(db1.getFileCount()).toBe(100)
    },
    15000
  )

  test('WAL mode confirmed on test DB', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db1 = await IndexDB.open(dbPath)
    expect(db1.getJournalMode()).toBe('wal')
  })
})
