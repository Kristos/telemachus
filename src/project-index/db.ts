import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CURRENT_VERSION = 1

export interface FileEntry {
  path: string
  size: number
  mtime: number
  extension: string
  language: string
  content_hash: string
}

export interface SymbolEntry {
  name: string
  kind: string
  line: number
}

/**
 * WAL-mode SQLite database for project file index.
 * Use IndexDB.open() — constructor is private.
 */
export class IndexDB {
  private db: Database | null

  private constructor(db: Database) {
    this.db = db
  }

  /**
   * Open (or create) a project index database at the given path.
   * Creates parent directories, enables WAL mode, runs schema migration.
   */
  static async open(dbPath: string): Promise<IndexDB> {
    mkdirSync(dirname(dbPath), { recursive: true })

    const rawDb = new Database(dbPath)

    // WAL mode for concurrent read/write access
    rawDb.exec('PRAGMA journal_mode=WAL')
    rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    rawDb.exec('PRAGMA foreign_keys=ON')

    const instance = new IndexDB(rawDb)

    // Schema migration via user_version
    const currentVersion = instance.getUserVersion()
    if (currentVersion < CURRENT_VERSION) {
      instance.migrate()
    }

    // SIGTERM handler: clean DB close. Use `once` so each instance only
    // registers a single firing — accumulating persistent handlers across
    // many open() calls (orchestration tests, project-index test suite) was
    // exhausting Node's listener limits and stalling the process during
    // bun test teardown on Linux.
    const sigHandler = (): void => {
      instance.close()
    }
    process.once('SIGTERM', sigHandler)

    return instance
  }

  private migrate(): void {
    if (!this.db) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        extension TEXT NOT NULL,
        language TEXT NOT NULL,
        content_hash TEXT NOT NULL
      )
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL
      )
    `)

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    this.db.exec(`PRAGMA user_version=${CURRENT_VERSION}`)
  }

  /** Returns the current user_version pragma value. */
  getUserVersion(): number {
    if (!this.db) return 0
    const row = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    return row?.user_version ?? 0
  }

  /** Returns the current journal_mode pragma value (e.g. 'wal'). */
  getJournalMode(): string {
    if (!this.db) return ''
    const row = this.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    return row?.journal_mode ?? ''
  }

  /** Close the database connection. Idempotent. */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // ── File CRUD ───────────────────────────────────────────────────────────────

  upsertFile(entry: FileEntry): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT OR REPLACE INTO files (path, size, mtime, extension, language, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.path, entry.size, entry.mtime, entry.extension, entry.language, entry.content_hash)
  }

  getFile(path: string): FileEntry | null {
    if (!this.db) return null
    const row = this.db.query<FileEntry, [string]>(
      'SELECT path, size, mtime, extension, language, content_hash FROM files WHERE path = ?'
    ).get(path)
    return row ?? null
  }

  getAllFiles(): FileEntry[] {
    if (!this.db) return []
    return this.db.query<FileEntry, []>(
      'SELECT path, size, mtime, extension, language, content_hash FROM files'
    ).all()
  }

  getFileCount(): number {
    if (!this.db) return 0
    const row = this.db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files').get()
    return row?.count ?? 0
  }

  /**
   * Remove any files from the index whose paths are not in currentPaths.
   * CASCADE delete propagates to symbols.
   */
  removeStaleFiles(currentPaths: Set<string>): void {
    if (!this.db) return
    if (currentPaths.size === 0) {
      this.db.exec('DELETE FROM files')
      return
    }
    const existing = this.db.query<{ path: string }, []>('SELECT path FROM files').all()
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?')
    for (const row of existing) {
      if (!currentPaths.has(row.path)) {
        stmt.run(row.path)
      }
    }
  }

  // ── Symbol CRUD ─────────────────────────────────────────────────────────────

  /**
   * Replace all symbols for the given file with the provided array.
   */
  upsertSymbols(filePath: string, symbols: SymbolEntry[]): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath)
    const insert = this.db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line) VALUES (?, ?, ?, ?)'
    )
    for (const sym of symbols) {
      insert.run(filePath, sym.name, sym.kind, sym.line)
    }
  }

  getSymbols(filePath: string): SymbolEntry[] {
    if (!this.db) return []
    return this.db.query<SymbolEntry, [string]>(
      'SELECT name, kind, line FROM symbols WHERE file_path = ? ORDER BY line'
    ).all(filePath)
  }

  searchSymbolsByName(name: string): Array<{ file_path: string; name: string; kind: string; line: number }> {
    if (!this.db) return []
    return this.db.query<{ file_path: string; name: string; kind: string; line: number }, [string]>(
      'SELECT file_path, name, kind, line FROM symbols WHERE name = ? ORDER BY file_path, line'
    ).all(name)
  }

  // ── Meta CRUD ───────────────────────────────────────────────────────────────

  setMeta(key: string, value: string): void {
    if (!this.db) return
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  getMeta(key: string): string | null {
    if (!this.db) return null
    const row = this.db.query<{ value: string }, [string]>(
      'SELECT value FROM meta WHERE key = ?'
    ).get(key)
    return row?.value ?? null
  }
}
