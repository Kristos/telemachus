import { join } from 'node:path'
import { IndexDB } from './db.js'
import { scanProject } from './scanner.js'

/**
 * Entry point for the `tm index` subcommand.
 * Supports:
 *   tm index          — full scan of current directory
 *   tm index watch    — file watcher mode (incremental, HEAD tracking)
 *   tm index status   — show index stats (file count, last scan, HEAD SHA)
 *   tm index serve    — MCP server mode (stdio transport)
 */
export async function runIndexSubcommand(args: string[]): Promise<void> {
  const dbPath = join(process.cwd(), '.kc-index', 'project.db')

  if (args[0] === 'serve') {
    const { startMcpServer } = await import('./mcp-server.js')
    await startMcpServer(dbPath)
    return
  }

  if (args[0] === 'watch') {
    const { IndexWatcher } = await import('./watcher.js')
    let db: IndexDB | null = null

    try {
      db = await IndexDB.open(dbPath)
    } catch (err) {
      process.stderr.write(
        `Error opening DB: ${err instanceof Error ? err.message : String(err)}\n`
      )
      process.exit(1)
    }

    process.stderr.write(`Watching ${process.cwd()} for changes...\n`)

    const watcher = IndexWatcher.start(db, process.cwd())

    const shutdown = () => {
      process.stderr.write('\nStopping watcher...\n')
      watcher.stop()
      db!.close()
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep alive — watcher runs in background via fs.watch + setInterval
    await new Promise<never>(() => {})
    return
  }

  if (args[0] === 'status') {
    let db: IndexDB | null = null
    try {
      db = await IndexDB.open(dbPath)
      const fileCount = db.getFileCount()
      const lastScan = db.getMeta('last_scan_time') ?? 'never'
      const headSha = db.getMeta('head_sha')
      const head7 = headSha ? headSha.slice(0, 7) : 'none'
      process.stdout.write(`Files: ${fileCount} | Last scan: ${lastScan} | HEAD: ${head7}\n`)
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`
      )
      process.exit(1)
    } finally {
      if (db) {
        db.close()
      }
    }
    return
  }

  // Default: full scan
  let db: IndexDB | null = null

  try {
    db = await IndexDB.open(dbPath)
    const result = scanProject(db, process.cwd())
    process.stdout.write(
      `Indexed ${result.filesScanned} files (${result.filesUpdated} updated, ${result.symbolsExtracted} symbols)\n`
    )
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  } finally {
    if (db) {
      db.close()
    }
  }
}
