import type { KristosConfig } from './types.js'

export const NO_TOOL_CALL_MODELS = ['llama3', 'phi3', 'gemma:2b', 'gemma:7b', 'tinyllama'] as const

const BASE_MATCHES = ['llama3', 'phi3', 'tinyllama']
const TAGGED_MATCHES = ['gemma:2b', 'gemma:7b']

/**
 * Returns a warning string if the active provider is Ollama and the configured
 * model is known not to support tool calls. Returns null otherwise.
 */
export function getOllamaToolWarning(config: KristosConfig): string | null {
  const cfg = config.providerConfigs[config.provider]
  if (!cfg?.isOllama) return null

  const model = (cfg.model ?? config.model).toLowerCase()
  const base = model.split(':')[0]

  const warn = BASE_MATCHES.includes(base) || TAGGED_MATCHES.includes(model)
  if (!warn) return null

  return `Warning: model ${model} on Ollama may not support tool calls. Consider qwen2.5-coder, llama3.1, or mistral-large.`
}
