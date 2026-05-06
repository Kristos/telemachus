import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexDB } from './db.js'
import { scanProject, detectLanguage } from './scanner.js'

let tmpDir: string
let db: IndexDB | null = null

beforeEach(() => {
  tmpDir = join(tmpdir(), `kc-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

function writeFile(relativePath: string, content: string): string {
  const absPath = join(tmpDir, relativePath)
  mkdirSync(join(absPath, '..'), { recursive: true })
  writeFileSync(absPath, content, 'utf-8')
  return absPath
}

describe('detectLanguage', () => {
  test('maps .ts to typescript', () => {
    expect(detectLanguage('.ts')).toBe('typescript')
  })

  test('maps .tsx to typescript', () => {
    expect(detectLanguage('.tsx')).toBe('typescript')
  })

  test('maps .js to javascript', () => {
    expect(detectLanguage('.js')).toBe('javascript')
  })

  test('maps .jsx to javascript', () => {
    expect(detectLanguage('.jsx')).toBe('javascript')
  })

  test('maps .json to json', () => {
    expect(detectLanguage('.json')).toBe('json')
  })

  test('maps .md to markdown', () => {
    expect(detectLanguage('.md')).toBe('markdown')
  })

  test('maps .css to css', () => {
    expect(detectLanguage('.css')).toBe('css')
  })

  test('maps .scss to css', () => {
    expect(detectLanguage('.scss')).toBe('css')
  })

  test('maps .html to html', () => {
    expect(detectLanguage('.html')).toBe('html')
  })

  test('maps .py to python', () => {
    expect(detectLanguage('.py')).toBe('python')
  })

  test('returns unknown for unrecognized extensions', () => {
    expect(detectLanguage('.xyz')).toBe('unknown')
  })
})

describe('scanProject', () => {
  test('returns correct filesScanned count', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/index.ts', 'export function main() {}')
    writeFile('src/utils.ts', 'export const UTIL = 1')
    writeFile('README.md', '# Project')

    const result = scanProject(db, tmpDir)
    expect(result.filesScanned).toBe(3)
  })

  test('upserts all files into the index', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/foo.ts', 'export function foo() {}')
    scanProject(db, tmpDir)

    const file = db.getFile('src/foo.ts')
    expect(file).not.toBeNull()
    expect(file!.language).toBe('typescript')
    expect(file!.extension).toBe('.ts')
  })

  test('extracts symbols for TypeScript files', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/foo.ts', 'export function myFn() {}\nexport class MyClass {}')
    scanProject(db, tmpDir)

    const symbols = db.getSymbols('src/foo.ts')
    const names = symbols.map(s => s.name)
    expect(names).toContain('myFn')
    expect(names).toContain('MyClass')
    expect(result => result).toBeTruthy()
  })

  test('re-scan with no changes returns filesUpdated: 0', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/index.ts', 'export function main() {}')
    scanProject(db, tmpDir)

    const second = scanProject(db, tmpDir)
    expect(second.filesUpdated).toBe(0)
  })

  test('modifying a file triggers update on re-scan', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    const absPath = writeFile('src/index.ts', 'export function main() {}')
    scanProject(db, tmpDir)

    // Modify file content and bump mtime
    writeFileSync(absPath, 'export function main() { return 1 }', 'utf-8')
    // Ensure mtime changes by setting it 1 second in the future
    const future = new Date(Date.now() + 1000)
    utimesSync(absPath, future, future)

    const second = scanProject(db, tmpDir)
    expect(second.filesUpdated).toBeGreaterThan(0)
  })

  test('stale file removal: deleted file removed from DB on re-scan', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    const absPath = writeFile('src/soon-deleted.ts', 'export const x = 1')
    scanProject(db, tmpDir)
    expect(db.getFile('src/soon-deleted.ts')).not.toBeNull()

    // Delete the file
    rmSync(absPath)

    scanProject(db, tmpDir)
    expect(db.getFile('src/soon-deleted.ts')).toBeNull()
  })

  test('excludes node_modules by default', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/index.ts', 'export function main() {}')
    writeFile('node_modules/lodash/index.js', 'module.exports = {}')

    scanProject(db, tmpDir)

    expect(db.getFile('node_modules/lodash/index.js')).toBeNull()
    expect(db.getFile('src/index.ts')).not.toBeNull()
  })

  test('excludes .git directory by default', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/index.ts', 'export function main() {}')
    writeFile('.git/config', '[core]')

    scanProject(db, tmpDir)

    expect(db.getFile('.git/config')).toBeNull()
  })

  test('sets last_scan_time meta', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/index.ts', 'export function main() {}')
    scanProject(db, tmpDir)

    const lastScan = db.getMeta('last_scan_time')
    expect(lastScan).not.toBeNull()
    expect(new Date(lastScan!).getFullYear()).toBeGreaterThan(2020)
  })

  test('returns symbolsExtracted count for TS/JS files', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('src/foo.ts', 'export function a() {}\nexport function b() {}')
    const result = scanProject(db, tmpDir)

    expect(result.symbolsExtracted).toBeGreaterThanOrEqual(2)
  })

  test('does not extract symbols for non-TS/JS files', async () => {
    const dbPath = join(tmpDir, '.kc-index', 'project.db')
    db = await IndexDB.open(dbPath)

    writeFile('README.md', '# Hello World')
    scanProject(db, tmpDir)

    const symbols = db.getSymbols('README.md')
    expect(symbols).toEqual([])
  })
})
