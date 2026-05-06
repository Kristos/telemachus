import type { IndexDB, FileEntry } from './db.js'

export type { FileEntry }

/**
 * Thin query interface over IndexDB.
 * Consumers depend on this interface, not directly on IndexDB,
 * making tests easy to mock without touching the database.
 */
export interface IndexClient {
  /** Returns all indexed files whose paths match the given glob pattern under basePath. */
  getFilesByGlob(pattern: string, basePath: string): FileEntry[]
  /** Returns all indexed files for the given programming language. */
  getFilesByLanguage(language: string): FileEntry[]
  /** Returns all indexed files for the given file extension (e.g. ".ts"). */
  getFilesByExtension(extension: string): FileEntry[]
  /** Single file lookup — returns null if not in index. */
  getFile(path: string): FileEntry | null
}

/**
 * Create an IndexClient backed by an IndexDB instance.
 *
 * getFilesByGlob uses Bun.Glob for in-memory matching because the dataset
 * is small enough (project files) and this avoids adding new SQL queries.
 */
export function createIndexClient(db: IndexDB): IndexClient {
  return {
    getFilesByGlob(pattern: string, basePath: string): FileEntry[] {
      const all = db.getAllFiles()
      const glob = new Bun.Glob(pattern)
      const normalizedBase = basePath.endsWith('/') ? basePath : basePath + '/'
      return all.filter((entry) => {
        // Only consider files under basePath
        if (!entry.path.startsWith(normalizedBase) && entry.path !== basePath) {
          return false
        }
        // Match relative path against the pattern
        const relative = entry.path.slice(normalizedBase.length)
        return glob.match(relative)
      })
    },

    getFilesByLanguage(language: string): FileEntry[] {
      return db.getAllFiles().filter((entry) => entry.language === language)
    },

    getFilesByExtension(extension: string): FileEntry[] {
      return db.getAllFiles().filter((entry) => entry.extension === extension)
    },

    getFile(path: string): FileEntry | null {
      return db.getFile(path)
    },
  }
}
