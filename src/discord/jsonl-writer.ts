/**
 * Phase 65 (HYG-03): Single-class encapsulation of the
 * `mkdir → open('a') → appendFile → datasync → close` pipeline that was
 * duplicated across token-budget.ts, usage-store.ts, and turn-summary-store.ts.
 *
 * Design:
 *   - resolveDir/resolvePath are callbacks (not constants) so date-partitioned
 *     stores rotate correctly across UTC midnight without restart.
 *   - warnContext is optional — consumers pass (r) => ({ userId: r.userId })
 *     or similar to surface identifying fields in log.warn output.
 *   - append() is best-effort (never throws). Mirrors the contract of
 *     src/security/audit.ts appendAuditEntry — agent-loop work never blocks
 *     on disk I/O, and a broken disk never kills the turn.
 *
 * Not migrated (per 65-CONTEXT.md deferred): src/security/audit.ts stays
 * independent to avoid circular-dep risk if JsonlWriter ever needs audit
 * emission for its own failures.
 */
import { open, mkdir } from 'node:fs/promises'
import { log } from '../log/logger.js'

export interface JsonlWriterOpts {
  /**
   * Resolves the directory path containing the active file. Called fresh
   * per append so date-partitioned stores rotate correctly.
   */
  resolveDir: () => string
  /**
   * Resolves the file path for a given timestamp. Callbacks receive the
   * record's parsed ts field so stores can partition by day (or hour,
   * or user) without re-parsing.
   */
  resolvePath: (ts: Date) => string
  /** Module name used for log.warn attribution (e.g. 'usage-store'). */
  module: string
  /**
   * Optional: extract extra fields to merge into the warn payload.
   * Called with the record being appended at the moment of failure so
   * the log line includes useful identifiers (userId, turnId, event, etc.).
   */
  warnContext?: (record: object) => Record<string, unknown>
}

/**
 * Append-only JSONL writer with best-effort semantics. Each append() call:
 *   1. mkdir -p the resolved directory
 *   2. open(path, 'a') — append-only flag, kernel O_APPEND guarantees atomicity
 *   3. appendFile(JSON.stringify(record) + '\n')
 *   4. datasync() — flush to disk before close
 *   5. close() — always runs (finally block)
 *
 * Failures are logged via log.warn with module + warnContext fields; never thrown.
 */
export class JsonlWriter {
  constructor(private readonly opts: JsonlWriterOpts) {}

  async append(record: { ts: string } & Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.opts.resolveDir(), { recursive: true })
      const ts = new Date(record.ts)
      const filePath = this.opts.resolvePath(ts)
      const line = JSON.stringify(record) + '\n'
      const fh = await open(filePath, 'a')
      try {
        await fh.appendFile(line, 'utf8')
        await fh.datasync()
      } finally {
        await fh.close()
      }
    } catch (err) {
      const ctx = this.opts.warnContext?.(record) ?? {}
      log(
        'warn',
        {
          module: this.opts.module,
          ...ctx,
          error: err instanceof Error ? err.message : String(err),
        },
        'could not append jsonl record',
      )
      // Never crash the agent — JSONL writes are best-effort.
    }
  }
}
