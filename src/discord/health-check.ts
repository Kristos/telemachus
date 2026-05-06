/**
 * Phase 34-01 (OPS-04): LLM endpoint connectivity probe.
 *
 * Sends a GET to `${baseURL}/models` (the standard OpenAI-compatible models
 * endpoint) with a configurable timeout. Returns a result object — never
 * throws — so callers can treat unreachable endpoints as a warning rather
 * than a fatal error.
 */

export interface LlmHealthResult {
  ok: boolean
  error?: string
}

/**
 * Check whether the LLM endpoint at `baseURL` is reachable.
 *
 * @param baseURL - Base URL of the OpenAI-compatible provider (e.g. `http://localhost:8080/v1`)
 * @param timeoutMs - Request timeout in milliseconds (default: 5000)
 * @returns `{ ok: true }` on success, `{ ok: false, error }` on any failure.
 *          Never throws.
 */
export async function checkLlmEndpoint(
  baseURL: string,
  timeoutMs = 5000,
  apiKey?: string,
): Promise<LlmHealthResult> {
  const url = `${baseURL.replace(/\/$/, '')}/models`
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      return { ok: true }
    }
    return { ok: false, error: `HTTP ${response.status}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}
