/**
 * Phase 63 (OBS-01): Pure error-shape classifier.
 *
 * Normalises any thrown value (Error, plain object, string, null, undefined)
 * into a flat { errorClass, errorMessage } pair suitable for dropping into an
 * audit entry or a rolling metric keyed by tool. The agent loop calls this
 * inside its try/catch around tool execution so every failure — whether it
 * surfaced as a throw or as {isError:true} — gets the same normalised shape.
 *
 * Decision table (checked in order):
 *   1. object with string-shaped `.code` (Node fs / Bun errors: EROFS, EBADF,
 *      ENOENT, etc.) → errorClass = code
 *   2. object with numeric `.status` or `.statusCode` → errorClass = 'HTTPError',
 *      message prefixed with the status (+ statusText when present)
 *   3. object with `.name` === 'TimeoutError' OR message matches /timeout/i
 *      → errorClass = 'Timeout'
 *   4. object with `.name` present (e.g. 'APIError', 'ZodError') → errorClass = name
 *   5. Error instance with no code/name hit → errorClass = 'Error'
 *   6. typeof string → errorClass = 'Unknown', message = the string
 *   7. anything else → errorClass = 'Unknown', message = String(err)
 *
 * errorMessage is always truncated to ≤500 chars with a trailing '…' when
 * truncation occurred — audit rows need to stay small and greppable.
 */

const MAX_MESSAGE_LEN = 500

function truncate(s: string): string {
  if (s.length <= MAX_MESSAGE_LEN) return s
  return s.slice(0, MAX_MESSAGE_LEN - 1) + '…'
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return String(err)
  if (typeof err === 'object') {
    const rec = err as Record<string, unknown>
    const msg = rec['message']
    if (typeof msg === 'string') return msg
  }
  return String(err)
}

export function classifyError(err: unknown): { errorClass: string; errorMessage: string } {
  // null / undefined / primitives first
  if (err === null || err === undefined) {
    return { errorClass: 'Unknown', errorMessage: truncate(String(err)) }
  }
  if (typeof err === 'string') {
    return { errorClass: 'Unknown', errorMessage: truncate(err) }
  }
  if (typeof err !== 'object') {
    return { errorClass: 'Unknown', errorMessage: truncate(String(err)) }
  }

  const rec = err as Record<string, unknown>
  const baseMessage = extractMessage(err)

  // 1. Node fs / Bun error code (EROFS, EBADF, ENOENT, ...)
  if (typeof rec['code'] === 'string' && rec['code']) {
    return {
      errorClass: rec['code'] as string,
      errorMessage: truncate(baseMessage),
    }
  }

  // 2. HTTP-shaped error (status or statusCode)
  const status =
    typeof rec['status'] === 'number'
      ? (rec['status'] as number)
      : typeof rec['statusCode'] === 'number'
        ? (rec['statusCode'] as number)
        : undefined
  if (status !== undefined) {
    const statusText = typeof rec['statusText'] === 'string' ? (rec['statusText'] as string) : ''
    const combined = statusText
      ? `HTTP ${status} ${statusText}: ${baseMessage}`
      : `HTTP ${status}: ${baseMessage}`
    return { errorClass: 'HTTPError', errorMessage: truncate(combined) }
  }

  // 3. Timeout detection by name or message
  const name = typeof rec['name'] === 'string' ? (rec['name'] as string) : ''
  if (name === 'TimeoutError' || (/timeout/i.test(baseMessage) && !name)) {
    return { errorClass: 'Timeout', errorMessage: truncate(baseMessage) }
  }

  // 4. Named error types (APIError, ZodError, ...) — skip the generic 'Error'
  //    so plain `new Error('boom')` takes path 5 with the stable 'Error' class.
  if (name && name !== 'Error') {
    return { errorClass: name, errorMessage: truncate(baseMessage) }
  }

  // 5. Error instance fallback
  if (err instanceof Error) {
    return { errorClass: 'Error', errorMessage: truncate(baseMessage) }
  }

  // 7. Catch-all
  return { errorClass: 'Unknown', errorMessage: truncate(String(err)) }
}
