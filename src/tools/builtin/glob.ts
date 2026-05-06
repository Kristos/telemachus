import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from '../types.js'
import { truncateResult } from '../../utils/truncate.js'

const globSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files (e.g. "**/*.ts", "src/**/*.tsx")'),
  path: z.string().optional().describe('Base directory to search in (defaults to cwd)'),
})

/**
 * SAND-05 (Phase 62, BACKLOG 999.15): guard filesystem-root basePath.
 *
 * Reproduction harness (internal reproduction harness) showed
 * 100% EBADF failures on darwin arm64 Bun 1.3.11 when basePath is '/' —
 * Bun.Glob walks `/dev/fd/N` descriptor paths that close mid-scan. The
 * SAND-02 probe should already fail the turn before this runs, but this
 * guard is belt-and-suspenders for any caller that somehow bypasses the
 * probe or explicitly passes `path: '/'`.
 */
function validateBasePath(basePath: string): { ok: true } | { ok: false; reason: string } {
  if (!basePath || basePath.length === 0) {
    return { ok: false, reason: "glob refused: basePath is empty. See SAND-05 / BACKLOG 999.15." }
  }
  if (basePath === '/') {
    return {
      ok: false,
      reason:
        "glob refused: basePath is filesystem root '/'. Bun.Glob enumerates /dev/fd/N file descriptors that close mid-scan, producing EBADF. See SAND-05 / BACKLOG 999.15.",
    }
  }
  return { ok: true }
}

/**
 * Filter transient descriptor paths. Even with basePath guarded, patterns
 * that deliberately target /dev/fd trigger the same EBADF failure mode.
 * Drop them from results before the lastModified sort step.
 */
function isTransientFdPath(path: string): boolean {
  return path.startsWith('/dev/fd/') || path.startsWith('/proc/self/fd/')
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Returns matching file paths sorted by modification time (newest first).',
  inputSchema: globSchema,

  async execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = globSchema.safeParse(args)
    if (!parsed.success) {
      return { content: `Invalid arguments: ${parsed.error.message}`, isError: true }
    }

    const { pattern, path } = parsed.data
    const basePath = path ?? context.cwd

    const check = validateBasePath(basePath)
    if (!check.ok) {
      return { content: check.reason, isError: true }
    }

    try {
      const glob = new Bun.Glob(pattern)
      const rawMatches = [...glob.scanSync({ cwd: basePath, absolute: true })]
      // SAND-05: strip /dev/fd/N and /proc/self/fd/N entries — these are
      // transient descriptor paths Bun.Glob enumerates when scanning near
      // the filesystem root; they close mid-scan and produce EBADF in the
      // subsequent lastModified sort step.
      const matches = rawMatches.filter((p) => !isTransientFdPath(p))

      if (matches.length === 0) {
        return { content: 'No files found', isError: false }
      }

      // Sort by modification time (newest first). Wrap the lastModified
      // access in a try/catch because the filesystem can race between the
      // scanSync snapshot and the sort step — ephemeral files (e.g. /tmp
      // cleanups) will surface as thrown errors we can absorb here without
      // aborting the whole glob result.
      matches.sort((a, b) => {
        let mA = 0
        let mB = 0
        try {
          mA = Bun.file(a).lastModified
        } catch {
          mA = 0
        }
        try {
          mB = Bun.file(b).lastModified
        } catch {
          mB = 0
        }
        return mB - mA
      })

      return {
        content: truncateResult(matches.join('\n')),
        isError: false,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // SAND-05: surface EBADF with explicit triage hint instead of a
      // generic "Failed to glob: ..." that previously went unnoticed in
      // 9 production occurrences.
      const hint = message.includes('EBADF')
        ? ' (likely caused by basePath resolving to a transient descriptor path; see SAND-05 / BACKLOG 999.15)'
        : ''
      return {
        content: `Failed to glob: ${message}${hint}`,
        isError: true,
      }
    }
  },
}
