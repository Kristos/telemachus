import { extname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { IndexDB, FileEntry } from './db.js'
import { extractSymbols } from './symbols.js'

const DEFAULT_EXCLUDE = [
  'node_modules',
  '.git',
  '.kc-index',
  'dist',
  'build',
  'coverage',
  '.next',
]

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
}

export interface ScanOptions {
  exclude?: string[]
}

export interface ScanResult {
  filesScanned: number
  filesUpdated: number
  symbolsExtracted: number
}

/**
 * Detect the language name for a file extension.
 * @param ext - File extension including the dot (e.g. '.ts')
 * @returns Language name or 'unknown'
 */
export function detectLanguage(ext: string): string {
  return LANGUAGE_MAP[ext] ?? 'unknown'
}

/**
 * Walk the project tree, hash files, upsert changed entries, remove stale entries.
 * Three-level staleness: mtime → if changed, check contentHash → if different, upsert.
 *
 * @param db - Open IndexDB instance
 * @param projectRoot - Absolute path to project root
 * @param opts - Optional scan configuration
 * @returns Scan statistics
 */
export function scanProject(db: IndexDB, projectRoot: string, opts?: ScanOptions): ScanResult {
  const excludeList = opts?.exclude ?? DEFAULT_EXCLUDE

  const glob = new Bun.Glob('**/*')
  const allCurrentPaths = new Set<string>()

  let filesScanned = 0
  let filesUpdated = 0
  let symbolsExtracted = 0

  for (const relativePath of glob.scanSync({ cwd: projectRoot, onlyFiles: true })) {
    // Check if any path segment matches an excluded name
    const segments = relativePath.split('/')
    const excluded = segments.some(seg => excludeList.includes(seg))
    if (excluded) continue

    allCurrentPaths.add(relativePath)
    filesScanned++

    const absolutePath = join(projectRoot, relativePath)
    const bunFile = Bun.file(absolutePath)
    const mtime = bunFile.lastModified
    const size = bunFile.size
    const ext = extname(relativePath)
    const language = detectLanguage(ext)

    const existing = db.getFile(relativePath)

    // Staleness level 1: mtime — if same, skip entirely (no change)
    if (existing && existing.mtime === mtime) {
      continue
    }

    // Staleness level 2+: mtime changed — read content and compute hash
    const content = readFileSync(absolutePath, 'utf-8')
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(content)
    const contentHash = hasher.digest('hex')

    // Staleness level 3: if hash same as existing, only update mtime (touch)
    if (existing && existing.content_hash === contentHash) {
      db.upsertFile({
        path: relativePath,
        size,
        mtime,
        extension: ext,
        language,
        content_hash: contentHash,
      })
      filesUpdated++
      continue
    }

    // Full upsert — content changed or new file
    const entry: FileEntry = {
      path: relativePath,
      size,
      mtime,
      extension: ext,
      language,
      content_hash: contentHash,
    }
    db.upsertFile(entry)
    filesUpdated++

    // Extract symbols for TypeScript and JavaScript files
    if (language === 'typescript' || language === 'javascript') {
      const symbols = extractSymbols(content, relativePath)
      if (symbols.length > 0) {
        db.upsertSymbols(relativePath, symbols as Array<{ name: string; kind: string; line: number }>)
        symbolsExtracted += symbols.length
      }
    }
  }

  // Remove files that no longer exist on disk
  db.removeStaleFiles(allCurrentPaths)

  // Record scan time in meta
  db.setMeta('last_scan_time', new Date().toISOString())

  return { filesScanned, filesUpdated, symbolsExtracted }
}
