/**
 * Static pricing table — keyed by model ID fragment.
 * Prices are in USD per million tokens.
 * Update this file when Anthropic/OpenAI change pricing.
 */
export interface ModelPricing {
  inputPerMToken: number   // USD per 1M input tokens
  outputPerMToken: number  // USD per 1M output tokens
  contextLimit: number     // max context window in tokens
}

// Entries are matched by checking if the model string includes the key
// Keys should be specific enough to avoid false matches
export const PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-6':       { inputPerMToken: 15.00, outputPerMToken: 75.00, contextLimit: 200000 },
  'claude-opus-4-5':       { inputPerMToken: 15.00, outputPerMToken: 75.00, contextLimit: 200000 },
  'claude-sonnet-4-6':     { inputPerMToken:  3.00, outputPerMToken: 15.00, contextLimit: 200000 },
  'claude-sonnet-4-5':     { inputPerMToken:  3.00, outputPerMToken: 15.00, contextLimit: 200000 },
  'claude-haiku-4-5':      { inputPerMToken:  0.80, outputPerMToken:  4.00, contextLimit: 200000 },
  'claude-3-5-sonnet':     { inputPerMToken:  3.00, outputPerMToken: 15.00, contextLimit: 200000 },
  'claude-3-5-haiku':      { inputPerMToken:  0.80, outputPerMToken:  4.00, contextLimit: 200000 },
  'claude-3-opus':         { inputPerMToken: 15.00, outputPerMToken: 75.00, contextLimit: 200000 },
  'gpt-4o-mini':           { inputPerMToken:  0.15, outputPerMToken:  0.60, contextLimit: 128000 },
  'gpt-4o':                { inputPerMToken:  2.50, outputPerMToken: 10.00, contextLimit: 128000 },
  'gpt-4-turbo':           { inputPerMToken: 10.00, outputPerMToken: 30.00, contextLimit: 128000 },
  'o1-mini':               { inputPerMToken:  3.00, outputPerMToken: 12.00, contextLimit: 128000 },
  'o1':                    { inputPerMToken: 15.00, outputPerMToken: 60.00, contextLimit: 200000 },
  // Z.ai GLM models (Phase 57, MEAS-03). Source: https://docs.z.ai/guides/overview/pricing (verified 2026-04-17)
  'glm-4.6':               { inputPerMToken:  0.60, outputPerMToken:  2.20, contextLimit: 200_000 },
  // COST-01 (Phase 61, 2026-04-19): empirical rate from v3.5-MILESTONE-REPORT §7.
  // Docs at https://docs.z.ai/guides/overview/pricing state GLM-4.7-Flash "Free"
  // but production measurement over an 11h46m window showed $0.834 of Z.ai balance
  // delta attributable to 777,498 Flash input + 12,867 output tokens — implied
  // input rate $1.07/MTok. Sibling GLM-4.7-FlashX at $0.07/$0.40 is 15× too low
  // to explain the observed spend. Root cause unconfirmed (likely silent
  // re-routing under load or tier change post-docs-freeze); a small overestimate
  // here is the conservative choice for Phase 61 SUCCESS-01 cost gate. Locked
  // by regression test in src/usage/pricing.test.ts — see that file's top-of-
  // file comment for full reconciliation narrative.
  'glm-4.7-flash':         { inputPerMToken:  1.00, outputPerMToken:  1.50, contextLimit: 128_000 },
  'glm-4.5-air':           { inputPerMToken:  0.20, outputPerMToken:  1.10, contextLimit: 128_000 },
  // glm-5.1 added during Phase 57-05 benchmark execution — production discord profile uses this model
  'glm-5.1':               { inputPerMToken:  1.40, outputPerMToken:  4.40, contextLimit: 128_000 },
}

/**
 * Look up pricing for a model. Matches by substring — most specific key wins.
 * Returns null for unknown models (e.g. local Ollama models).
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Try exact match first
  if (PRICING_TABLE[model]) return PRICING_TABLE[model]

  // Try substring match — prefer longer (more specific) keys
  let best: ModelPricing | null = null
  let bestKeyLen = 0

  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
    if (model.includes(key) && key.length > bestKeyLen) {
      best = pricing
      bestKeyLen = key.length
    }
  }

  return best
}

/**
 * Phase 57 (MEAS-03): Resolve per-model pricing with optional override.
 *
 * Lookup order:
 *   1. discordConfig.pricing[model] override (operator-managed correction layer)
 *   2. PRICING_TABLE substring match via getModelPricing
 *
 * Returns null only when both sources miss. Override values are mapped from
 * DiscordConfig's `{input, output}` shape to ModelPricing's `inputPerMToken/outputPerMToken`.
 * The contextLimit is preserved from the substring-matched row when available,
 * defaulting to 200_000 when the model is unknown to PRICING_TABLE.
 */
export function resolveModelPricing(
  model: string,
  discordConfig?: { pricing?: Record<string, { input: number; output: number }> },
): ModelPricing | null {
  const override = discordConfig?.pricing?.[model]
  if (override) {
    const fallback = getModelPricing(model)
    return {
      inputPerMToken: override.input,
      outputPerMToken: override.output,
      contextLimit: fallback?.contextLimit ?? 200_000,
    }
  }
  return getModelPricing(model)
}

/**
 * Calculate USD cost for a single turn.
 * Returns 0 for unknown models.
 */
export function calculateTurnCost(
  usage: { inputTokens: number; outputTokens: number },
  model: string,
): number {
  const pricing = getModelPricing(model)
  if (!pricing) return 0

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMToken
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMToken

  return inputCost + outputCost
}

/**
 * Get the context limit for a model (defaults to 200000 if unknown).
 */
export function getContextLimit(model: string): number {
  return getModelPricing(model)?.contextLimit ?? 200_000
}
