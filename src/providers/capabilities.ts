// Pure vision capability detection per (provider, model).
//
// This is the SINGLE place where vision rules live. Do not duplicate
// these checks elsewhere — import `modelSupportsVision` instead.
//
// Rules are intentionally string-pattern based, so adding a new
// vision-capable model usually means appending one regex.
//
// TODO (architectural decision §3): for `llamacpp`/`ollama` we currently
// rely on a name heuristic. A future extension is to query the running
// server's `/v1/models` endpoint and inspect the multimodal flag/capability
// list at startup, then cache the result on the provider instance. Out of
// scope for plan 21-03 — this would require an async capability source.

const ANTHROPIC_VISION_PREFIXES = [
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4-5',
] as const

const OPENAI_VISION_RE = /gpt-4o|gpt-4-vision|gpt-4\.1|gpt-5/i
const LOCAL_VISION_RE = /vision|(^|[-_])vl([-_]|$)|multimodal|llava/i

export function modelSupportsVision(provider: string, model: string): boolean {
  if (!provider || !model) return false
  const p = provider.toLowerCase()
  const m = model.toLowerCase()

  if (p === 'anthropic') {
    return ANTHROPIC_VISION_PREFIXES.some(prefix => m.startsWith(prefix))
  }

  if (p === 'openai' || p === 'openai-compat') {
    return OPENAI_VISION_RE.test(model)
  }

  if (p === 'gemini') {
    return true
  }

  if (p === 'llamacpp' || p === 'ollama') {
    return LOCAL_VISION_RE.test(model)
  }

  return false
}
