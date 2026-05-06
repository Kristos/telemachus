import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { Tool, ToolContext } from '../types.js'
import type { IndexClient } from '../../project-index/client.js'
import { z } from 'zod'

// Re-export so callers can import IndexClient from this module if convenient
export type { IndexClient }

// ─── Glob schema (mirrors glob.ts) ──────────────────────────────────────────

const globSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
})

// ─── Grep schema (mirrors grep.ts) ──────────────────────────────────────────

const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional().default('.'),
  include: z.string().optional(),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .default('files_with_matches'),
})

// ─── Extension → language mapping ───────────────────────────────────────────

/**
 * Map a glob include pattern like "*.ts" to a file extension like ".ts".
 * Returns null if we can't infer a single extension.
 */
function includeToExtension(include: string): string | null {
  // Handle patterns like "*.ts", "**/*.ts", "*.tsx"
  const match = include.match(/\*\.([a-zA-Z0-9]+)$/)
  if (!match) return null
  return '.' + match[1]
}

// ─── makeIndexAwareGlob ──────────────────────────────────────────────────────

/**
 * Wrap the original glob tool with index awareness.
 *
 * - client=null: returns originalGlob unchanged (opt-out, TOOL-03)
 * - Fresh index: returns sorted paths from index without touching filesystem
 * - Stale or empty: transparently falls back to originalGlob.execute
 */
export function makeIndexAwareGlob(originalGlob: Tool, client: IndexClient | null): Tool {
  if (client === null) return originalGlob

  return {
    name: originalGlob.name,
    description: originalGlob.description,
    inputSchema: originalGlob.inputSchema,

    async execute(args: unknown, context: ToolContext) {
      const parsed = globSchema.safeParse(args)
      if (!parsed.success) {
        // Let original handle invalid args
        return originalGlob.execute(args, context)
      }

      const { pattern, path } = parsed.data
      const basePath = path ?? context.cwd

      // Query index
      const entries = client.getFilesByGlob(pattern, basePath)

      if (entries.length === 0) {
        // No index hits — fall back to live scan
        return originalGlob.execute(args, context)
      }

      // Freshness check: compare each index mtime to real filesystem mtime
      for (const entry of entries) {
        const fsMtime = Bun.file(entry.path).lastModified
        if (fsMtime !== entry.mtime) {
          // At least one stale entry — fall back to live scan
          return originalGlob.execute(args, context)
        }
      }

      // All entries are fresh — return sorted by mtime descending
      const sorted = [...entries].sort((a, b) => b.mtime - a.mtime)
      return {
        content: sorted.map((e) => e.path).join('\n'),
        isError: false,
      }
    },
  }
}

// ─── makeIndexAwareGrep ──────────────────────────────────────────────────────

/**
 * Wrap the original grep tool with index-based candidate pre-filtering.
 *
 * - client=null: returns originalGrep unchanged (opt-out, TOOL-03)
 * - include param present + matching files: writes a temp file-list and passes
 *   it to the original grep via a modified `path` argument
 * - No include or zero index hits: transparently falls back to originalGrep.execute
 */
export function makeIndexAwareGrep(originalGrep: Tool, client: IndexClient | null): Tool {
  if (client === null) return originalGrep

  return {
    name: originalGrep.name,
    description: originalGrep.description,
    inputSchema: originalGrep.inputSchema,

    async execute(args: unknown, context: ToolContext) {
      const parsed = grepSchema.safeParse(args)
      if (!parsed.success) {
        return originalGrep.execute(args, context)
      }

      const { include } = parsed.data

      // No include filter → no index pre-filtering benefit
      if (!include) {
        return originalGrep.execute(args, context)
      }

      const ext = includeToExtension(include)
      if (!ext) {
        // Complex pattern we can't map to a single extension — fall back
        return originalGrep.execute(args, context)
      }

      const candidates = client.getFilesByExtension(ext)

      if (candidates.length === 0) {
        // Index has no files for this extension — fall back
        return originalGrep.execute(args, context)
      }

      // Write candidate paths to a temp file
      const tmpPath = join(tmpdir(), `kc-grep-list-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      writeFileSync(tmpPath, candidates.map((f) => f.path).join('\n') + '\n')

      // Pass the temp file as `path` to the original grep.
      // The original grep will pass it to rg, which treats a file path
      // (not a directory) as a direct target. We also clear `include`
      // so rg doesn't double-filter.
      const modifiedArgs = {
        ...parsed.data,
        path: tmpPath,
        include: undefined,
      }

      return originalGrep.execute(modifiedArgs, context)
    },
  }
}
