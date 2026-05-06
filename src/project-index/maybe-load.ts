import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IndexDB } from './db.js'
import { createIndexClient, type IndexClient } from './client.js'

export interface LoadedIndex {
  db: IndexDB
  client: IndexClient
}

/**
 * Attempt to load the project index from the given project root.
 *
 * Returns null when no .kc-index/project.db exists — production entry points
 * should pass the optional IndexClient (or null) to buildAllTools so that
 * index-aware tools activate only when an index has been built for this project.
 *
 * Silent fallback: no warning when the DB is absent.
 * Caller is responsible for db.close() on session cleanup.
 */
export async function maybeLoadIndexClient(
  projectRoot: string = process.cwd(),
): Promise<LoadedIndex | null> {
  const dbPath = join(projectRoot, '.kc-index', 'project.db')
  if (!existsSync(dbPath)) {
    return null
  }
  try {
    const db = await IndexDB.open(dbPath)
    const client = createIndexClient(db)
    return { db, client }
  } catch (err) {
    // Best-effort: an unusable index should never break a session.
    process.stderr.write(
      `[project-index] failed to open ${dbPath}: ${(err as Error).message}\n`,
    )
    return null
  }
}
