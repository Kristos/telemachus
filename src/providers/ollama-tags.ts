/**
 * Query a running Ollama daemon for its installed models via GET /api/tags.
 * Fail-soft: any error (network, timeout, malformed JSON) resolves to [].
 */

interface OllamaTagsResponse {
  models?: Array<{ name: string }>
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const host = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const url = `${host}/api/tags`
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return []
    const json = (await res.json()) as OllamaTagsResponse
    return json.models?.map(m => m.name) ?? []
  } catch {
    return []
  }
}
