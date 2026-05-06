import type { KristosConfig } from './types.js'

export interface ModelSelection {
  providerKey: string
  model: string
}

/**
 * Build a new KristosConfig that reflects a model picker selection.
 *
 * This is the single source of truth for "how do we route picker keys to
 * the registry's dispatch slot?". The registry resolves providers by
 * `providerConfigs[config.provider]`, which means picking a friendly key
 * like `ollama` or `lmstudio` (which both run through the openai-compat
 * provider class) requires us to *materialize* that key's config into
 * the `openai-compat` slot before calling createProvider. Otherwise the
 * OpenAI SDK silently defaults baseURL to api.openai.com and you get
 * "401 Incorrect API key provided: ollama" — a real bug observed in the
 * field.
 *
 * Throws when the picked key has no providerConfigs entry, so callers
 * fail loudly instead of mis-routing.
 */
export function applyModelSelection(
  config: KristosConfig,
  option: ModelSelection,
): KristosConfig {
  // 1) anthropic — has its own provider class, no materialization needed.
  if (option.providerKey === 'anthropic') {
    return {
      ...config,
      provider: 'anthropic',
      model: option.model,
      providerConfigs: {
        ...config.providerConfigs,
        anthropic: {
          ...(config.providerConfigs.anthropic ?? { model: option.model }),
          model: option.model,
        },
      },
    }
  }

  // 2) llamacpp — has its own dispatch case in the registry.
  if (option.providerKey === 'llamacpp') {
    const source = config.providerConfigs.llamacpp
    if (!source) {
      throw new Error(
        'Cannot switch to llamacpp: no providerConfigs.llamacpp entry. ' +
          'Add one to ~/.telemachus/config.json with at least { model, baseURL }.',
      )
    }
    return {
      ...config,
      provider: 'llamacpp',
      model: option.model,
      providerConfigs: {
        ...config.providerConfigs,
        llamacpp: { ...source, model: option.model },
      },
    }
  }

  // 3) Everything else (ollama, lmstudio, openrouter, deepseek, groq, xai,
  //    a literal `openai-compat` entry, …) routes through the openai-compat
  //    provider class. We MUST copy the chosen entry into the openai-compat
  //    slot so the registry's lookup resolves to the right baseURL/apiKey.
  const source = config.providerConfigs[option.providerKey]
  if (!source) {
    throw new Error(
      `Cannot switch to provider "${option.providerKey}": no providerConfigs.${option.providerKey} entry found in your config.`,
    )
  }
  return {
    ...config,
    provider: 'openai-compat',
    model: option.model,
    providerConfigs: {
      ...config.providerConfigs,
      // Preserve the original entry so it stays visible to the picker.
      [option.providerKey]: { ...source, model: option.model },
      // Materialize into the dispatch slot the registry reads from.
      'openai-compat': { ...source, model: option.model },
    },
  }
}
