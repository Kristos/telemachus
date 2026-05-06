import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { statSync } from 'node:fs'
import { IndexDB } from './db.js'

// ── Pure tool handler functions (exported for testing) ──────────────────────

export function handleSearchFiles(
  db: IndexDB,
  args: { pattern?: string; language?: string; directory?: string }
): string {
  const all = db.getAllFiles()

  let filtered = all

  if (args.pattern !== undefined) {
    const glob = new Bun.Glob(args.pattern)
    filtered = filtered.filter((entry) => {
      // Match against relative path (strip cwd prefix) or full path
      const filename = entry.path.split('/').pop() ?? entry.path
      return glob.match(filename) || glob.match(entry.path)
    })
  }

  if (args.language !== undefined) {
    filtered = filtered.filter((entry) => entry.language === args.language)
  }

  if (args.directory !== undefined) {
    const dir = args.directory.endsWith('/') ? args.directory : args.directory + '/'
    filtered = filtered.filter(
      (entry) => entry.path.startsWith(dir) || entry.path.startsWith('/' + dir)
    )
  }

  const results = filtered.map((entry) => ({
    path: entry.path,
    size: entry.size,
    language: entry.language,
  }))

  return JSON.stringify(results)
}

export function handleFindSymbol(db: IndexDB, args: { name: string }): string {
  const results = db.searchSymbolsByName(args.name)

  if (results.length === 0) {
    return JSON.stringify({ message: `No symbols found matching '${args.name}'` })
  }

  return JSON.stringify(results)
}

export function handleListSymbols(db: IndexDB, args: { file_path: string }): string {
  const file = db.getFile(args.file_path)

  if (!file) {
    return JSON.stringify({ message: `File not in index: ${args.file_path}` })
  }

  const symbols = db.getSymbols(args.file_path)
  return JSON.stringify(symbols)
}

export function handleIndexStatus(db: IndexDB): string {
  const fileCount = db.getFileCount()
  const lastScanTime = db.getMeta('last_scan_time')
  const headSha = db.getMeta('head_sha')

  // Sample up to 100 files to estimate staleness
  const allFiles = db.getAllFiles()
  const sampleSize = Math.min(allFiles.length, 100)
  const sample = allFiles.slice(0, sampleSize)

  let staleFiles = 0
  for (const entry of sample) {
    try {
      const stat = statSync(entry.path)
      const fsMtime = stat.mtimeMs
      // Compare with stored mtime (both in ms)
      if (Math.abs(fsMtime - entry.mtime) > 1000) {
        staleFiles++
      }
    } catch {
      // File missing from filesystem — counts as stale
      staleFiles++
    }
  }

  const stalenessPct =
    sampleSize > 0 ? Math.round((staleFiles / sampleSize) * 100) : 0

  return JSON.stringify({
    file_count: fileCount,
    last_scan_time: lastScanTime ?? null,
    head_sha: headSha ?? null,
    stale_files: staleFiles,
    sample_size: sampleSize,
    staleness_pct: stalenessPct,
  })
}

// ── MCP server factory ───────────────────────────────────────────────────────

export function createIndexMcpServer(db: IndexDB): McpServer {
  const server = new McpServer({ name: 'kc-index', version: '1.0.0' })

  server.tool(
    'search_files',
    'Search indexed project files by glob pattern, language, or directory prefix',
    {
      pattern: z.string().optional().describe('Glob pattern to match file paths (e.g. "*.ts")'),
      language: z.string().optional().describe('Filter by programming language (e.g. "typescript")'),
      directory: z.string().optional().describe('Filter files under this directory prefix (e.g. "src/tools")'),
    },
    async (args) => {
      const result = handleSearchFiles(db, args)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  server.tool(
    'find_symbol',
    'Find all files containing a named symbol (function, class, variable, etc.)',
    {
      name: z.string().describe('Symbol name to search for (exact match)'),
    },
    async (args) => {
      const result = handleFindSymbol(db, args)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  server.tool(
    'list_symbols',
    'List all exported symbols for a specific file path from the index',
    {
      file_path: z.string().describe('Absolute or relative file path as stored in the index'),
    },
    async (args) => {
      const result = handleListSymbols(db, args)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  server.tool(
    'index_status',
    'Report index health: file count, last scan time, HEAD SHA, and staleness estimate',
    {},
    async () => {
      const result = handleIndexStatus(db)
      return { content: [{ type: 'text' as const, text: result }] }
    }
  )

  return server
}

// ── Entry point for tm index serve ──────────────────────────────────────────

export async function startMcpServer(dbPath: string): Promise<void> {
  const db = await IndexDB.open(dbPath)
  const server = createIndexMcpServer(db)
  const transport = new StdioServerTransport()

  const shutdown = async () => {
    await server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.stderr.write('[index-mcp] server starting\n')
  await server.connect(transport)
  process.stderr.write('[index-mcp] server connected\n')
}
