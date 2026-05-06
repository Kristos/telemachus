/**
 * Phase 64 (CACHE-01, CACHE-02): Anthropic prompt caching helpers.
 *
 * Wires `cache_control: { type: 'ephemeral' }` onto the system prompt and
 * the tail tool of the tools array so that the Anthropic API caches the
 * system + tools bundle across CLI turns within the 5-minute ephemeral TTL.
 *
 * Empirical behavior verified in internal cache probe:
 * a 1237-token system prompt with cache_control attached drops billed input
 * from 1237 → 21 tokens on the second call.
 *
 * Thresholds come from the Anthropic SDK — below-threshold prompts cannot
 * attach cache_control (API rejects). We use a conservative char/4 heuristic
 * so the occasional mis-trigger costs nothing.
 */

/**
 * Model-specific minimum token thresholds for prompt caching.
 * - Haiku models: 2048 tokens minimum (per SDK docs)
 * - Sonnet, Opus, and unknown models: 1024 tokens minimum
 */
export function resolveCacheThreshold(modelId: string): number {
  if (modelId.includes('haiku')) return 2048
  return 1024
}

/**
 * Returns the system field shape to pass to client.messages.stream.
 * Below threshold: passes through raw string (no cache_control — API rejects).
 * Above threshold: wraps in a one-element text block array with ephemeral cache_control.
 * Empty string: passes through unchanged.
 */
export function attachSystemCache(
  prompt: string,
  modelId: string,
): string | Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }> {
  if (prompt === '') return prompt
  const estimatedTokens = Math.ceil(prompt.length / 4)
  if (estimatedTokens < resolveCacheThreshold(modelId)) return prompt
  return [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]
}

/**
 * Phase 64 (CACHE-02): Attach `cache_control: { type: 'ephemeral' }` to the
 * LAST element of the tools array when the combined serialized size exceeds
 * the model-specific threshold. Anthropic's cache breakpoint semantics are
 * cumulative: attaching to the tail marks "everything up to and including
 * this block" (system + all tools) as one cacheable unit.
 *
 * Empty array → passthrough (no crash, no attach).
 * Below threshold → passthrough (API rejects below-threshold cache attempts).
 * Above threshold → new array; last element spread + cache_control attached;
 * prior elements structurally unchanged.
 *
 * Generic T because the beta path uses a union type (regular tools + web_search
 * server tool) — cache_control is an open attach, not a type constraint.
 */
export function maybeCacheToolsArray<T extends { name: string }>(
  tools: T[],
  modelId: string,
): T[] {
  if (tools.length === 0) return tools
  const serialized = JSON.stringify(tools)
  const estimatedTokens = Math.ceil(serialized.length / 4)
  if (estimatedTokens < resolveCacheThreshold(modelId)) return tools
  const last = tools[tools.length - 1]!
  return [
    ...tools.slice(0, -1),
    { ...last, cache_control: { type: 'ephemeral' as const } } as T,
  ]
}
