/**
 * Query a running llama.cpp (or any OpenAI-compatible) server for its loaded
 * models via GET /v1/models. Fail-soft: any error resolves to [].
 *
 * llama.cpp typically only has one model loaded at a time, but the endpoint
 * still returns it under `data[].id` per the OpenAI spec — and some users run
 * it via litellm/llamafile/llama-swap which can serve multiple. We surface
 * whatever is there.
 */

interface OpenAIModelsResponse {
  data?: Array<{ id: string }>
}

export async function fetchLlamaCppModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  try {
    // Normalize: ensure exactly one /v1 suffix.
    const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const url = `${root}/v1/models`
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as OpenAIModelsResponse
    return json.data?.map(m => m.id).filter(Boolean) ?? []
  } catch {
    return []
  }
}
