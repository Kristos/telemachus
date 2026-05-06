/**
 * Phase 56 (LOG-01): Structured JSON line logger.
 *
 * Emits one JSON line per call to process.stderr with shape:
 *   { ts, level, msg, ...fields }
 *
 * Mirrors the audit.ts JSON line shape (src/security/audit.ts) so future
 * tooling can cross-reference log + audit streams via sessionId/runId fields.
 *
 * Env-gated: set KC_LOG_LEVEL=debug|info|warn|error (default: info).
 * Best-effort: circular refs and write failures are silently handled — logger
 * must NEVER throw and must never crash the hot path.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function currentThreshold(): number {
  const env = process.env.KC_LOG_LEVEL
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return LEVEL_ORDER[env]
  }
  // Unknown or missing env var → default info
  return LEVEL_ORDER.info
}

/**
 * Emit a structured JSON log line to stderr.
 *
 * @param level  - Severity level. Filtered against KC_LOG_LEVEL (default: info).
 * @param fields - Arbitrary key/value context. Spread AFTER base fields so
 *                 callers can intentionally override `ts`, `level`, or `msg`.
 * @param msg    - Short human-readable message (becomes the `msg` field unless
 *                 overridden by a `msg` key in `fields`).
 */
export function log(
  level: LogLevel,
  fields: Record<string, unknown>,
  msg: string,
): void {
  if (LEVEL_ORDER[level] < currentThreshold()) return

  const base = { ts: new Date().toISOString(), level, msg }

  let line: string
  try {
    line = JSON.stringify({ ...base, ...fields })
  } catch (err) {
    // Circular reference or other serialization error — emit a fallback line.
    const fallback = {
      ts: base.ts,
      level: 'error' as const,
      msg: 'logger_serialize_failed',
      error: err instanceof Error ? err.message : String(err),
    }
    try {
      line = JSON.stringify(fallback)
    } catch {
      // If even the fallback fails, emit a static sentinel.
      line = '{"level":"error","msg":"logger_serialize_failed"}'
    }
  }

  try {
    process.stderr.write(line + '\n')
  } catch {
    // Best-effort — never throw from the logger.
  }
}
