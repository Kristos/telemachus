import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexDB } from './db.js'

let tmpDir: string
let db: IndexDB | null = null

beforeEach(() => {
  tmpDir = join(tmpdir(), `kc-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(async () => {
  if (db) {
    db.close()
    db = null
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('IndexDB.open', () => {
  test('creates .kc-index directory and database file', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    expect(existsSync(dbPath)).toBe(true)
  })

  test('opens in WAL mode', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    const result = db.getJournalMode()
    expect(result).toBe('wal')
  })

  test('sets user_version to 1 on new DB', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    expect(db.getUserVersion()).toBe(1)
  })

  test('idempotent on second open — does not error', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    db.close()
    db = await IndexDB.open(dbPath)
    expect(db.getUserVersion()).toBe(1)
  })
})

describe('IndexDB.close', () => {
  test('close is callable and idempotent (no error on double close)', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    db.close()
    db.close() // second call must not throw
    db = null
  })
})

describe('IndexDB file CRUD', () => {
  test('upsertFile and getFile round-trip', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    const entry = {
      path: 'src/index.ts',
      size: 1024,
      mtime: Date.now(),
      extension: '.ts',
      language: 'typescript',
      content_hash: 'abc123',
    }
    db.upsertFile(entry)
    const result = db.getFile('src/index.ts')
    expect(result).not.toBeNull()
    expect(result!.path).toBe('src/index.ts')
    expect(result!.size).toBe(1024)
    expect(result!.content_hash).toBe('abc123')
    expect(result!.language).toBe('typescript')
  })

  test('getFile returns null for missing path', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    expect(db.getFile('nonexistent.ts')).toBeNull()
  })

  test('upsertFile replaces existing row', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    const entry = {
      path: 'src/index.ts',
      size: 100,
      mtime: 1000,
      extension: '.ts',
      language: 'typescript',
      content_hash: 'hash1',
    }
    db.upsertFile(entry)
    db.upsertFile({ ...entry, size: 200, content_hash: 'hash2' })

    const result = db.getFile('src/index.ts')
    expect(result!.size).toBe(200)
    expect(result!.content_hash).toBe('hash2')
  })

  test('getAllFiles returns all inserted rows', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'a.ts', size: 1, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.upsertFile({ path: 'b.ts', size: 2, mtime: 2, extension: '.ts', language: 'typescript', content_hash: 'h2' })

    const files = db.getAllFiles()
    expect(files.length).toBe(2)
    const paths = files.map(f => f.path)
    expect(paths).toContain('a.ts')
    expect(paths).toContain('b.ts')
  })

  test('getFileCount returns correct count', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    expect(db.getFileCount()).toBe(0)
    db.upsertFile({ path: 'a.ts', size: 1, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    expect(db.getFileCount()).toBe(1)
  })

  test('removeStaleFiles deletes files not in current set', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'a.ts', size: 1, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.upsertFile({ path: 'b.ts', size: 2, mtime: 2, extension: '.ts', language: 'typescript', content_hash: 'h2' })
    db.upsertFile({ path: 'c.ts', size: 3, mtime: 3, extension: '.ts', language: 'typescript', content_hash: 'h3' })

    db.removeStaleFiles(new Set(['a.ts', 'c.ts']))

    expect(db.getFile('a.ts')).not.toBeNull()
    expect(db.getFile('b.ts')).toBeNull()
    expect(db.getFile('c.ts')).not.toBeNull()
    expect(db.getFileCount()).toBe(2)
  })

  test('removeStaleFiles with empty set deletes all', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'a.ts', size: 1, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.removeStaleFiles(new Set())
    expect(db.getFileCount()).toBe(0)
  })
})

describe('IndexDB symbols CRUD', () => {
  test('upsertSymbols and getSymbols round-trip', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'src/foo.ts', size: 100, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.upsertSymbols('src/foo.ts', [
      { name: 'myFunction', kind: 'function', line: 1 },
      { name: 'MyClass', kind: 'class', line: 10 },
    ])

    const symbols = db.getSymbols('src/foo.ts')
    expect(symbols.length).toBe(2)
    expect(symbols.find(s => s.name === 'myFunction')!.kind).toBe('function')
    expect(symbols.find(s => s.name === 'MyClass')!.kind).toBe('class')
  })

  test('upsertSymbols replaces existing symbols for file', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'src/foo.ts', size: 100, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.upsertSymbols('src/foo.ts', [{ name: 'oldFn', kind: 'function', line: 1 }])
    db.upsertSymbols('src/foo.ts', [{ name: 'newFn', kind: 'function', line: 5 }])

    const symbols = db.getSymbols('src/foo.ts')
    expect(symbols.length).toBe(1)
    expect(symbols[0].name).toBe('newFn')
  })

  test('getSymbols returns [] for file with no symbols', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'src/foo.ts', size: 100, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    expect(db.getSymbols('src/foo.ts')).toEqual([])
  })

  test('CASCADE delete: deleting file removes its symbols', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.upsertFile({ path: 'src/foo.ts', size: 100, mtime: 1, extension: '.ts', language: 'typescript', content_hash: 'h1' })
    db.upsertSymbols('src/foo.ts', [{ name: 'myFn', kind: 'function', line: 1 }])

    // Delete file via removeStaleFiles (leaves empty set)
    db.removeStaleFiles(new Set())

    expect(db.getSymbols('src/foo.ts')).toEqual([])
  })
})

describe('IndexDB meta', () => {
  test('setMeta and getMeta round-trip', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.setMeta('last_scan_time', '2026-04-14T00:00:00Z')
    expect(db.getMeta('last_scan_time')).toBe('2026-04-14T00:00:00Z')
  })

  test('getMeta returns null for missing key', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)
    expect(db.getMeta('nonexistent')).toBeNull()
  })

  test('setMeta replaces existing value', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    db.setMeta('key', 'value1')
    db.setMeta('key', 'value2')
    expect(db.getMeta('key')).toBe('value2')
  })
})
