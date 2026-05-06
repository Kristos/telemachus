import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import type { IndexClient } from '../../project-index/client.js'
import type { FileEntry } from '../../project-index/db.js'
import { makeIndexAwareGlob, makeIndexAwareGrep } from './index-aware.js'

// Minimal ToolContext for testing
const ctx: ToolContext = {
  cwd: '/project',
  toolTimeoutMs: 5000,
  permissionMode: 'yolo',
  allowedPaths: [],
  trustedPaths: [],
  sandboxMode: 'none',
}

// Fake original glob tool
function makeFakeGlob(results: string[] = []): Tool {
  return {
    name: 'glob',
    description: 'fake glob',
    inputSchema: {} as any,
    execute: async (_args: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
      content: results.join('\n') || 'No files found',
      isError: false,
    }),
  }
}

// Fake original grep tool
function makeFakeGrep(result: string = 'No matches found'): Tool {
  return {
    name: 'grep',
    description: 'fake grep',
    inputSchema: {} as any,
    execute: async (_args: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
      content: result,
      isError: false,
    }),
  }
}

function makeFile(path: string, mtime: number = 1000): FileEntry {
  const ext = path.includes('.') ? '.' + path.split('.').pop()! : ''
  return {
    path,
    size: 100,
    mtime,
    extension: ext,
    language: ext === '.ts' ? 'typescript' : ext === '.js' ? 'javascript' : 'text',
    content_hash: 'hash',
  }
}

// ─── makeIndexAwareGlob ──────────────────────────────────────────────────────

describe('makeIndexAwareGlob', () => {
  test('Test 1: client=null returns originalGlob unchanged (reference equality)', () => {
    const original = makeFakeGlob()
    const result = makeIndexAwareGlob(original, null)
    expect(result).toBe(original)
  })

  test('Test 2: fresh entries — returns index results without calling original', async () => {
    const file1 = makeFile('/project/src/a.ts', 1000)
    const file2 = makeFile('/project/src/b.ts', 2000)

    const mockClient: IndexClient = {
      getFilesByGlob: () => [file1, file2],
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [],
      getFile: (path: string) => (path === file1.path ? file1 : path === file2.path ? file2 : null),
    }

    // Spy on Bun.file to return matching mtimes (fresh)
    const bunFileSpy = spyOn(Bun, 'file').mockImplementation((path: string) => ({
      lastModified: path === '/project/src/a.ts' ? 1000 : 2000,
    }) as any)

    const originalCalled: boolean[] = []
    const original: Tool = {
      ...makeFakeGlob(),
      execute: async () => {
        originalCalled.push(true)
        return { content: 'fallback', isError: false }
      },
    }

    const wrapped = makeIndexAwareGlob(original, mockClient)
    const result = await wrapped.execute({ pattern: '**/*.ts', path: '/project' }, ctx)

    expect(originalCalled).toHaveLength(0)
    expect(result.isError).toBe(false)
    // Both files returned, sorted by mtime desc
    const lines = result.content.split('\n')
    expect(lines[0]).toBe('/project/src/b.ts') // mtime 2000
    expect(lines[1]).toBe('/project/src/a.ts') // mtime 1000

    bunFileSpy.mockRestore()
  })

  test('Test 3: stale entry falls back to original glob', async () => {
    const file1 = makeFile('/project/src/a.ts', 1000)

    const mockClient: IndexClient = {
      getFilesByGlob: () => [file1],
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [],
      getFile: () => file1,
    }

    // Return different mtime → stale
    const bunFileSpy = spyOn(Bun, 'file').mockImplementation((_path: string) => ({
      lastModified: 9999, // different from index mtime 1000
    }) as any)

    const original = makeFakeGlob(['/project/src/a.ts', '/project/src/c.ts'])
    const wrapped = makeIndexAwareGlob(original, mockClient)
    const result = await wrapped.execute({ pattern: '**/*.ts', path: '/project' }, ctx)

    // Should return original fallback result
    expect(result.content).toContain('/project/src/c.ts')

    bunFileSpy.mockRestore()
  })

  test('Test 4: zero matching entries falls back to original glob', async () => {
    const mockClient: IndexClient = {
      getFilesByGlob: () => [], // no matches
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [],
      getFile: () => null,
    }

    const original = makeFakeGlob(['/project/src/live.ts'])
    const wrapped = makeIndexAwareGlob(original, mockClient)
    const result = await wrapped.execute({ pattern: '**/*.ts', path: '/project' }, ctx)

    expect(result.content).toContain('/project/src/live.ts')
  })

  test('Test 5: results sorted by mtime descending', async () => {
    const files = [
      makeFile('/project/a.ts', 500),
      makeFile('/project/b.ts', 3000),
      makeFile('/project/c.ts', 1500),
    ]

    const mockClient: IndexClient = {
      getFilesByGlob: () => files,
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [],
      getFile: (path: string) => files.find((f) => f.path === path) ?? null,
    }

    const bunFileSpy = spyOn(Bun, 'file').mockImplementation((path: string) => {
      const file = files.find((f) => f.path === path)
      return { lastModified: file?.mtime ?? 0 } as any
    })

    const original = makeFakeGlob()
    const wrapped = makeIndexAwareGlob(original, mockClient)
    const result = await wrapped.execute({ pattern: '**/*.ts', path: '/project' }, ctx)

    const lines = result.content.split('\n')
    expect(lines[0]).toBe('/project/b.ts') // mtime 3000
    expect(lines[1]).toBe('/project/c.ts') // mtime 1500
    expect(lines[2]).toBe('/project/a.ts') // mtime 500

    bunFileSpy.mockRestore()
  })
})

// ─── makeIndexAwareGrep ──────────────────────────────────────────────────────

describe('makeIndexAwareGrep', () => {
  test('Test 1: client=null returns originalGrep unchanged (reference equality)', () => {
    const original = makeFakeGrep()
    const result = makeIndexAwareGrep(original, null)
    expect(result).toBe(original)
  })

  test('Test 2: include="*.ts" pre-filters to typescript files from index', async () => {
    const tsFiles = [
      makeFile('/project/src/a.ts', 1000),
      makeFile('/project/src/b.ts', 2000),
    ]

    const mockClient: IndexClient = {
      getFilesByGlob: () => [],
      getFilesByLanguage: () => [],
      getFilesByExtension: (ext: string) => (ext === '.ts' ? tsFiles : []),
      getFile: () => null,
    }

    // Capture what args the original grep gets called with
    const capturedArgs: unknown[] = []
    const original: Tool = {
      ...makeFakeGrep(),
      execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
        capturedArgs.push(args)
        return { content: 'grep results', isError: false }
      },
    }

    const wrapped = makeIndexAwareGrep(original, mockClient)
    const result = await wrapped.execute(
      { pattern: 'somePattern', path: '.', include: '*.ts', output_mode: 'files_with_matches' },
      ctx
    )

    expect(result.content).toBe('grep results')
    expect(capturedArgs).toHaveLength(1)
    // The args passed to original grep should use --file-list approach
    // We check that the path passed is a temp file path (not the original '.')
    const passedArgs = capturedArgs[0] as Record<string, unknown>
    // The wrapped call should pass a file path pointing to a temp list
    expect(typeof passedArgs.path).toBe('string')
    // The path must differ from original '.' — it should be an absolute path to a temp file
    expect(passedArgs.path).not.toBe('.')
  })

  test('Test 3: no include param falls back to original grep', async () => {
    const mockClient: IndexClient = {
      getFilesByGlob: () => [],
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [],
      getFile: () => null,
    }

    const originalCalled: boolean[] = []
    const original: Tool = {
      ...makeFakeGrep(),
      execute: async () => {
        originalCalled.push(true)
        return { content: 'original result', isError: false }
      },
    }

    const wrapped = makeIndexAwareGrep(original, mockClient)
    const result = await wrapped.execute({ pattern: 'somePattern', path: '.' }, ctx)

    expect(result.content).toBe('original result')
    expect(originalCalled).toHaveLength(1)
  })

  test('Test 4: zero matching files for extension falls back to original grep', async () => {
    const mockClient: IndexClient = {
      getFilesByGlob: () => [],
      getFilesByLanguage: () => [],
      getFilesByExtension: () => [], // no matches
      getFile: () => null,
    }

    const originalCalled: boolean[] = []
    const original: Tool = {
      ...makeFakeGrep(),
      execute: async () => {
        originalCalled.push(true)
        return { content: 'original fallback', isError: false }
      },
    }

    const wrapped = makeIndexAwareGrep(original, mockClient)
    const result = await wrapped.execute(
      { pattern: 'somePattern', path: '.', include: '*.ts' },
      ctx
    )

    expect(result.content).toBe('original fallback')
    expect(originalCalled).toHaveLength(1)
  })
})
