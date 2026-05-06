import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexDB } from './db.js'
import {
  handleSearchFiles,
  handleFindSymbol,
  handleListSymbols,
  handleIndexStatus,
} from './mcp-server.js'

let db: IndexDB
let tmpDir: string

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kc-index-test-'))
  db = await IndexDB.open(join(tmpDir, 'test.db'))

  // Seed test files
  db.upsertFile({
    path: 'src/project-index/db.ts',
    size: 4200,
    mtime: 1000000,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'abc123',
  })
  db.upsertFile({
    path: 'src/tools/bash.ts',
    size: 1800,
    mtime: 1000001,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'def456',
  })
  db.upsertFile({
    path: 'src/tools/read.ts',
    size: 900,
    mtime: 1000002,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'ghi789',
  })
  db.upsertFile({
    path: 'src/config/index.ts',
    size: 550,
    mtime: 1000003,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'jkl012',
  })
  db.upsertFile({
    path: 'scripts/build.py',
    size: 300,
    mtime: 1000004,
    extension: '.py',
    language: 'python',
    content_hash: 'mno345',
  })

  // Seed symbols
  db.upsertSymbols('src/project-index/db.ts', [
    { name: 'IndexDB', kind: 'class', line: 26 },
    { name: 'FileEntry', kind: 'interface', line: 7 },
    { name: 'SymbolEntry', kind: 'interface', line: 14 },
  ])
  db.upsertSymbols('src/tools/bash.ts', [
    { name: 'IndexDB', kind: 'function', line: 5 }, // intentional duplicate name for cross-file test
    { name: 'runBash', kind: 'function', line: 12 },
  ])
  db.upsertSymbols('src/config/index.ts', [
    { name: 'loadConfig', kind: 'function', line: 8 },
  ])

  // Set some meta
  db.setMeta('last_scan_time', '2026-04-14T10:00:00Z')
  db.setMeta('head_sha', 'abc1234567890abcdef')
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true })
})

// ── IndexDB.searchSymbolsByName ──────────────────────────────────────────────

describe('searchSymbolsByName', () => {
  test('returns results across multiple files for known symbol', () => {
    const results = db.searchSymbolsByName('IndexDB')
    expect(results).toHaveLength(2)
    const paths = results.map((r) => r.file_path)
    expect(paths).toContain('src/project-index/db.ts')
    expect(paths).toContain('src/tools/bash.ts')
    expect(results[0]).toMatchObject({ name: 'IndexDB', kind: expect.any(String), line: expect.any(Number) })
  })

  test('returns empty array for unknown symbol', () => {
    const results = db.searchSymbolsByName('nonexistent')
    expect(results).toHaveLength(0)
  })
})

// ── handleSearchFiles ────────────────────────────────────────────────────────

describe('handleSearchFiles', () => {
  test('filters by glob pattern *.py', () => {
    const raw = handleSearchFiles(db, { pattern: '*.py' })
    const results = JSON.parse(raw) as Array<{ path: string }>
    expect(results).toHaveLength(1)
    expect(results[0].path).toBe('scripts/build.py')
  })

  test('filters by language typescript', () => {
    const raw = handleSearchFiles(db, { language: 'typescript' })
    const results = JSON.parse(raw) as Array<{ path: string; language: string }>
    expect(results.length).toBeGreaterThanOrEqual(4)
    expect(results.every((r) => r.language === 'typescript')).toBe(true)
  })

  test('filters by directory prefix', () => {
    const raw = handleSearchFiles(db, { directory: 'src/tools' })
    const results = JSON.parse(raw) as Array<{ path: string }>
    const paths = results.map((r) => r.path)
    expect(paths).toContain('src/tools/bash.ts')
    expect(paths).toContain('src/tools/read.ts')
    expect(paths).not.toContain('src/project-index/db.ts')
  })

  test('returns all files when no filters given', () => {
    const raw = handleSearchFiles(db, {})
    const results = JSON.parse(raw) as Array<{ path: string }>
    expect(results.length).toBe(5)
  })
})

// ── handleFindSymbol ─────────────────────────────────────────────────────────

describe('handleFindSymbol', () => {
  test('returns matching symbols with file_path, name, kind, line', () => {
    const raw = handleFindSymbol(db, { name: 'IndexDB' })
    const results = JSON.parse(raw) as Array<{ file_path: string; name: string; kind: string; line: number }>
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      file_path: expect.any(String),
      name: 'IndexDB',
      kind: expect.any(String),
      line: expect.any(Number),
    })
  })

  test('returns message object for no matches', () => {
    const raw = handleFindSymbol(db, { name: 'nonexistent' })
    const result = JSON.parse(raw) as { message: string }
    expect(result.message).toBe("No symbols found matching 'nonexistent'")
  })
})

// ── handleListSymbols ────────────────────────────────────────────────────────

describe('handleListSymbols', () => {
  test('returns symbols for known file', () => {
    const raw = handleListSymbols(db, { file_path: 'src/project-index/db.ts' })
    const results = JSON.parse(raw) as Array<{ name: string; kind: string; line: number }>
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toMatchObject({ name: expect.any(String), kind: expect.any(String), line: expect.any(Number) })
    const names = results.map((r) => r.name)
    expect(names).toContain('IndexDB')
  })

  test('returns error message for unknown file', () => {
    const raw = handleListSymbols(db, { file_path: 'missing.ts' })
    const result = JSON.parse(raw) as { message: string }
    expect(result.message).toBe('File not in index: missing.ts')
  })
})

// ── handleIndexStatus ────────────────────────────────────────────────────────

describe('handleIndexStatus', () => {
  test('returns correct file_count and meta fields', () => {
    const raw = handleIndexStatus(db)
    const status = JSON.parse(raw) as {
      file_count: number
      last_scan_time: string | null
      head_sha: string | null
      stale_files: number
      sample_size: number
      staleness_pct: number
    }
    expect(status.file_count).toBe(5)
    expect(status.last_scan_time).toBe('2026-04-14T10:00:00Z')
    expect(status.head_sha).toBe('abc1234567890abcdef')
    expect(typeof status.stale_files).toBe('number')
    expect(typeof status.sample_size).toBe('number')
    expect(typeof status.staleness_pct).toBe('number')
    expect(status.sample_size).toBe(5) // only 5 files in test db
  })
})
