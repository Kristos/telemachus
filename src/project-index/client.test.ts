import { describe, test, expect } from 'bun:test'
import type { FileEntry } from './db.js'
import { createIndexClient } from './client.js'
import type { IndexClient } from './client.js'

// Mock IndexDB that returns controlled data
function makeDB(files: FileEntry[]) {
  return {
    getAllFiles: () => files,
    getFile: (path: string) => files.find((f) => f.path === path) ?? null,
  }
}

const sampleFiles: FileEntry[] = [
  {
    path: '/project/src/foo.ts',
    size: 100,
    mtime: 1000,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'abc',
  },
  {
    path: '/project/src/bar.ts',
    size: 200,
    mtime: 2000,
    extension: '.ts',
    language: 'typescript',
    content_hash: 'def',
  },
  {
    path: '/project/src/baz.js',
    size: 150,
    mtime: 1500,
    extension: '.js',
    language: 'javascript',
    content_hash: 'ghi',
  },
  {
    path: '/project/README.md',
    size: 50,
    mtime: 500,
    extension: '.md',
    language: 'markdown',
    content_hash: 'jkl',
  },
]

describe('createIndexClient', () => {
  test('getFilesByGlob returns files matching pattern under basePath', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByGlob('**/*.ts', '/project')
    expect(results).toHaveLength(2)
    const paths = results.map((f) => f.path)
    expect(paths).toContain('/project/src/foo.ts')
    expect(paths).toContain('/project/src/bar.ts')
  })

  test('getFilesByGlob returns empty array when no files match', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByGlob('**/*.py', '/project')
    expect(results).toHaveLength(0)
  })

  test('getFilesByGlob filters to files under basePath only', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    // Only files under /project/src
    const results = client.getFilesByGlob('**/*.ts', '/project/src')
    expect(results).toHaveLength(2)
    for (const f of results) {
      expect(f.path.startsWith('/project/src')).toBe(true)
    }
  })

  test('getFilesByLanguage returns all files for that language', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByLanguage('typescript')
    expect(results).toHaveLength(2)
    for (const f of results) {
      expect(f.language).toBe('typescript')
    }
  })

  test('getFilesByLanguage returns empty array for unknown language', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByLanguage('python')
    expect(results).toHaveLength(0)
  })

  test('getFilesByExtension returns all files for that extension', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByExtension('.ts')
    expect(results).toHaveLength(2)
    for (const f of results) {
      expect(f.extension).toBe('.ts')
    }
  })

  test('getFilesByExtension returns empty array for unknown extension', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const results = client.getFilesByExtension('.py')
    expect(results).toHaveLength(0)
  })

  test('getFile delegates to db.getFile', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const file = client.getFile('/project/src/foo.ts')
    expect(file).not.toBeNull()
    expect(file?.path).toBe('/project/src/foo.ts')
  })

  test('getFile returns null for missing path', () => {
    const client = createIndexClient(makeDB(sampleFiles) as any)
    const file = client.getFile('/project/nope.ts')
    expect(file).toBeNull()
  })
})
