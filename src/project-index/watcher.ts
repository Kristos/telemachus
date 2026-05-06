import { watch, readFileSync, existsSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import type { IndexDB } from './db.js'
import { scanProject, detectLanguage } from './scanner.js'
import { extractSymbols } from './symbols.js'

const DEFAULT_EXCLUDE = ['node_modules', '.git', '.kc-index', 'dist', 'build', 'coverage', '.next']

export interface WatcherOptions {
  exclude?: string[]
  headPollIntervalMs?: number
  debounceMs?: number
}

/**
 * Read the current HEAD SHA from a .git directory.
 * Handles both detached HEAD (SHA directly) and symbolic refs (ref: refs/heads/...).
 * Returns null if .git/HEAD does not exist.
 */
export function getCurrentHeadSha(projectRoot: string): string | null {
  const headPath = join(projectRoot, '.git', 'HEAD')
  if (!existsSync(headPath)) return null

  const headContent = readFileSync(headPath, 'utf-8').trim()

  if (headContent.startsWith('ref: ')) {
    // Symbolic ref — read the referenced file
    const refPath = headContent.slice(5).trim() // e.g. "refs/heads/main"
    const refFilePath = join(projectRoot, '.git', refPath)
    if (!existsSync(refFilePath)) return null
    return readFileSync(refFilePath, 'utf-8').trim() || null
  }

  // Detached HEAD — the SHA is directly in the file
  return headContent || null
}

/**
 * File watcher that keeps the project index live.
 *
 * On start:
 *   1. Runs a full diff-scan via scanProject() to catch offline changes
 *   2. Stores current HEAD SHA in meta
 *   3. Starts fs.watch with 100ms debounce for incremental updates
 *   4. Polls HEAD SHA every 2s to detect branch changes
 *
 * Use IndexWatcher.start() — constructor is private.
 */
export class IndexWatcher {
  private fsWatcher: ReturnType<typeof watch> | null = null
  private headPollInterval: ReturnType<typeof setInterval> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPaths: Set<string> = new Set()
  private readonly db: IndexDB
  private readonly projectRoot: string
  private readonly excludeDirs: string[]
  private readonly debounceMs: number

  private constructor(
    db: IndexDB,
    projectRoot: string,
    excludeDirs: string[],
    debounceMs: number
  ) {
    this.db = db
    this.projectRoot = projectRoot
    this.excludeDirs = excludeDirs
    this.debounceMs = debounceMs
  }

  /**
   * Start watching projectRoot for file changes.
   * Performs a diff-scan immediately to catch offline changes.
   */
  static start(db: IndexDB, projectRoot: string, opts?: WatcherOptions): IndexWatcher {
    const excludeDirs = opts?.exclude ?? DEFAULT_EXCLUDE
    const debounceMs = opts?.debounceMs ?? 100
    const headPollIntervalMs = opts?.headPollIntervalMs ?? 2000

    const instance = new IndexWatcher(db, projectRoot, excludeDirs, debounceMs)
    instance.runDiffScan()
    instance.startFsWatch()
    instance.startHeadPolling(headPollIntervalMs)

    return instance
  }

  /**
   * Run a full diff-scan using scanProject to catch all offline changes.
   * Also stores current HEAD SHA in meta.
   */
  private runDiffScan(): void {
    scanProject(this.db, this.projectRoot, { exclude: this.excludeDirs })

    const headSha = getCurrentHeadSha(this.projectRoot)
    if (headSha) {
      this.db.setMeta('head_sha', headSha)
    }
  }

  /**
   * Start fs.watch with recursive watching and debounced batch processing.
   */
  private startFsWatch(): void {
    try {
      this.fsWatcher = watch(
        this.projectRoot,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (!filename) return
          this.pendingPaths.add(filename)
          this.scheduleDebouncedProcess()
        }
      )
      // On Linux (inotify), deleting a watched file emits an 'error' event with
      // ENOENT. Handle it gracefully so the watcher doesn't crash the process.
      this.fsWatcher.on('error', () => {
        // Ignore watcher errors (e.g. ENOENT on Linux when a watched file is deleted).
        // The deletion was already dispatched as a 'rename' event before the error.
      })
    } catch {
      // fs.watch may throw on some platforms — swallow and continue
    }
  }

  private scheduleDebouncedProcess(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.processPendingPaths()
    }, this.debounceMs)
    if (typeof this.debounceTimer === 'object' && this.debounceTimer !== null && 'unref' in this.debounceTimer) {
      (this.debounceTimer as { unref(): void }).unref()
    }
  }

  private processPendingPaths(): void {
    const paths = new Set(this.pendingPaths)
    this.pendingPaths.clear()

    for (const relativeOrAbs of paths) {
      // Normalize: fs.watch can return relative or absolute paths
      const relativePath = relativeOrAbs.startsWith(this.projectRoot)
        ? relative(this.projectRoot, relativeOrAbs)
        : relativeOrAbs

      // Skip excluded dirs
      const segments = relativePath.split(/[/\\]/)
      if (segments.some(seg => this.excludeDirs.includes(seg))) continue

      const absolutePath = join(this.projectRoot, relativePath)

      // Normalize path separators to forward slashes for DB keys
      const dbPath = relativePath.replace(/\\/g, '/')

      const bunFile = Bun.file(absolutePath)

      if (!existsSync(absolutePath)) {
        // File deleted — remove from DB
        this.removeFileFromDb(dbPath)
        continue
      }

      // File exists — check staleness and upsert if changed
      this.upsertFileIfChanged(absolutePath, dbPath, bunFile)
    }
  }

  private removeFileFromDb(dbPath: string): void {
    // Use removeStaleFiles with the current DB minus this file
    const allFiles = this.db.getAllFiles()
    const remaining = new Set(allFiles.map(f => f.path).filter(p => p !== dbPath))
    // Direct removal: pass set without the deleted file
    // If remaining is the full set minus the deleted, removeStaleFiles handles it
    this.db.removeStaleFiles(remaining)
  }

  private upsertFileIfChanged(absolutePath: string, dbPath: string, bunFile: ReturnType<typeof Bun.file>): void {
    const mtime = bunFile.lastModified
    const size = bunFile.size
    const ext = extname(dbPath)
    const language = detectLanguage(ext)

    const existing = this.db.getFile(dbPath)

    // Level 1: mtime unchanged — skip
    if (existing && existing.mtime === mtime) return

    // Level 2+: read content and compute hash
    let content: string
    try {
      content = readFileSync(absolutePath, 'utf-8')
    } catch {
      return // File may have been deleted between check and read
    }

    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(content)
    const contentHash = hasher.digest('hex')

    // Level 3: hash unchanged — only update mtime
    if (existing && existing.content_hash === contentHash) {
      this.db.upsertFile({ path: dbPath, size, mtime, extension: ext, language, content_hash: contentHash })
      return
    }

    // Full upsert
    this.db.upsertFile({ path: dbPath, size, mtime, extension: ext, language, content_hash: contentHash })

    // Extract symbols for TS/JS
    if (language === 'typescript' || language === 'javascript') {
      const symbols = extractSymbols(content, dbPath)
      if (symbols.length > 0) {
        this.db.upsertSymbols(dbPath, symbols as Array<{ name: string; kind: string; line: number }>)
      }
    }
  }

  /**
   * Poll HEAD SHA every headPollIntervalMs ms.
   * When HEAD changes: run git diff --name-only to get affected files, re-scan them.
   * Falls back to full scanProject if git diff fails.
   */
  private startHeadPolling(intervalMs: number): void {
    this.headPollInterval = setInterval(() => {
      this.checkHeadChange()
    }, intervalMs)
    // unref(): don't keep the process alive just for polling.
    // Allows bun test to exit cleanly after all tests complete.
    if (typeof this.headPollInterval === 'object' && this.headPollInterval !== null && 'unref' in this.headPollInterval) {
      (this.headPollInterval as { unref(): void }).unref()
    }
  }

  private checkHeadChange(): void {
    const newHead = getCurrentHeadSha(this.projectRoot)
    if (!newHead) return

    const oldHead = this.db.getMeta('head_sha')
    if (!oldHead || oldHead === newHead) {
      if (!oldHead && newHead) {
        this.db.setMeta('head_sha', newHead)
      }
      return
    }

    // HEAD changed — update meta first
    this.db.setMeta('head_sha', newHead)

    // Try to get affected files via git diff
    this.invalidateChangedFiles(oldHead, newHead)
  }

  private invalidateChangedFiles(oldHead: string, newHead: string): void {
    try {
      const proc = Bun.spawnSync(['git', 'diff', '--name-only', oldHead, newHead], {
        cwd: this.projectRoot,
        stderr: 'pipe',
      })

      if (proc.exitCode === 0) {
        const output = proc.stdout.toString('utf-8').trim()
        if (!output) return

        const changedFiles = output.split('\n').filter(Boolean)
        for (const relPath of changedFiles) {
          const absolutePath = join(this.projectRoot, relPath)
          const dbPath = relPath.replace(/\\/g, '/')
          const bunFile = Bun.file(absolutePath)

          if (!existsSync(absolutePath)) {
            this.removeFileFromDb(dbPath)
          } else {
            this.upsertFileIfChanged(absolutePath, dbPath, bunFile)
          }
        }
        return
      }
    } catch {
      // git command unavailable or failed
    }

    // Fallback: full re-scan
    scanProject(this.db, this.projectRoot, { exclude: this.excludeDirs })
  }

  /**
   * Stop the watcher — close fs.watch, clear intervals/timers.
   * Does NOT close the DB (caller manages DB lifecycle).
   */
  stop(): void {
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close()
      } catch {
        // Ignore errors on close
      }
      this.fsWatcher = null
    }

    if (this.headPollInterval) {
      clearInterval(this.headPollInterval)
      this.headPollInterval = null
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.pendingPaths.clear()
  }
}
