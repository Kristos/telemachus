import { encode } from 'gpt-tokenizer'
import type { Message, ContentBlock, Provider } from '../providers/types.js'
import { getModelPricing } from '../usage/pricing.js'

// COST-06 (Phase 61): warn-once memoization for unsupported providers so
// the [count-tokens] fallback log doesn't spam every turn.
const warnedUnsupported = new Set<string>()
function warnOnceUnsupported(channelId: string, providerName: string): void {
  const key = `${providerName}:${channelId}`
  if (warnedUnsupported.has(key)) return
  warnedUnsupported.add(key)
  process.stderr.write(
    `[count-tokens] provider=${providerName} does not implement countTokens; falling through to char/4 heuristic (channel=${channelId})\n`,
  )
}

/**
 * COST-07 (Phase 61): resolve the token cap for a routed model.
 *
 * Precedence:
 *   1. profileOverride — explicit `ProfileConfig.contextTokenCap` wins
 *   2. Model-specific default (Flash/glm-4.6/Sonnet/Haiku)
 *   3. PRICING_TABLE.contextLimit / 2 for known models (safety margin)
 *   4. 32_000 conservative fallback for unknown models
 *
 * Defaults align with CONTEXT.md §"COST-07 window cap strategy":
 *   64k Flash, 128k glm-4.6, 160k Sonnet 4.5 (300k context / 2 - ~20k tool schemas).
 */
export function resolveContextCap(
  routedModel: string,
  profileOverride?: number,
): number {
  if (profileOverride !== undefined && profileOverride > 0) return profileOverride
  if (routedModel.includes('glm-4.7-flash')) return 64_000
  if (routedModel.includes('glm-4.6')) return 128_000
  if (routedModel.includes('glm-4.5-air')) return 64_000
  if (routedModel.includes('glm-5.1')) return 64_000
  if (routedModel.includes('claude-sonnet') || routedModel.includes('claude-opus')) return 160_000
  if (routedModel.includes('claude-haiku')) return 80_000
  // Fallback: use PRICING_TABLE.contextLimit / 2 if available, else 32k conservative.
  const pricing = getModelPricing(routedModel)
  return pricing ? Math.floor(pricing.contextLimit / 2) : 32_000
}

/**
 * Per-channel conversation history store.
 *
 * Each Discord channel (or DM/thread) gets an isolated Message[] history.
 * getHistory returns a defensive copy so callers cannot mutate stored state.
 *
 * Phase 56 (TRUNC-01): Rolling-window cap prevents unbounded growth.
 * After each push, if queue length exceeds maxTurns * 2, the oldest
 * entries are spliced from the head (FIFO eviction). Default maxTurns: 40.
 */
export class ConversationManager {
  private readonly sessions = new Map<string, Message[]>()
  private readonly maxTurns: number

  constructor(maxTurns: number = 40) {
    // Clamp invalid inputs to default 40 (ops-friendly; never throw)
    this.maxTurns = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 40
  }

  addUserMessage(channelId: string, content: string): void {
    const arr = this.ensure(channelId)
    arr.push({ role: 'user', content })
    this.truncate(arr)
  }

  addAssistantMessage(channelId: string, content: string): void {
    const arr = this.ensure(channelId)
    arr.push({ role: 'assistant', content })
    this.truncate(arr)
  }

  getHistory(channelId: string): Message[] {
    return [...(this.sessions.get(channelId) ?? [])]
  }

  clear(channelId: string): void {
    this.sessions.delete(channelId)
  }

  /**
   * Phase 57 (STRIP-01): total token estimate for a channel via gpt-tokenizer.
   * Concatenates all message content (string verbatim; ContentBlock[] via per-block
   * walk: text → block.text, others → JSON.stringify(block)). Returns 0 on
   * tokenizer error or empty channel.
   */
  getTokenEstimate(channelId: string): number {
    const arr = this.sessions.get(channelId)
    if (!arr || arr.length === 0) return 0
    const parts: string[] = []
    for (const msg of arr) {
      if (msg.content == null) continue
      if (typeof msg.content === 'string') {
        parts.push(msg.content)
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(block.text)
          } else {
            parts.push(JSON.stringify(block))
          }
        }
      }
    }
    const joined = parts.join('\n')
    try {
      return encode(joined).length
    } catch {
      return 0
    }
  }

  /**
   * COST-07 (Phase 61): enforce token-bounded context cap by dropping oldest
   * user+assistant pairs atomically. Never strips mid-turn — tool-call chains
   * (assistant with tool_use + user with tool_result) stay together because
   * pair boundary detection finds the next `user` message, and tool_result
   * messages are user-role.
   *
   * Behavior:
   *   - Empty channel → no-op ({ before: 0, after: 0, dropped: 0 })
   *   - provider.countTokens missing / throws → fallthrough to getTokenEstimate
   *   - Under-cap → no-op (single provider call for measurement, no drops, no warning)
   *   - Over-cap → drop pairs from the oldest end until under cap; emit ONE
   *     [context-cap] stderr line per truncation event
   *   - Defensive max-iterations: 50 drop cycles before bailing (pathological guard)
   */
  async enforceTokenCap(
    channelId: string,
    provider: Provider,
    cap: number,
  ): Promise<{ before: number; after: number; dropped: number }> {
    const arr = this.sessions.get(channelId)
    if (!arr || arr.length === 0) return { before: 0, after: 0, dropped: 0 }

    const measure = async (): Promise<number> => {
      if (typeof provider.countTokens !== 'function') {
        return this.getTokenEstimate(channelId)
      }
      try {
        return await provider.countTokens([...arr])
      } catch {
        return this.getTokenEstimate(channelId)
      }
    }

    const before = await measure()
    if (before <= cap) return { before, after: before, dropped: 0 }

    // Drop oldest user+assistant pairs. A pair starts at the first non-system
    // message and extends to (but not including) the next user message, so
    // tool-call chains (assistant tool_use + user tool_result sequences) are
    // preserved as units.
    let dropped = 0
    let current = before
    const maxIter = 50 // defensive guard against pathological inputs
    let iter = 0

    while (current > cap && arr.length > 2 && iter < maxIter) {
      iter++
      // Skip any leading system messages.
      let dropStart = 0
      while (dropStart < arr.length && arr[dropStart].role === 'system') dropStart++
      if (dropStart >= arr.length - 2) break // nothing safe left to drop

      // dropStart is a user message (typically); pair ends before next user.
      let dropEnd = dropStart + 1
      while (dropEnd < arr.length && arr[dropEnd].role !== 'user') dropEnd++
      const pairSize = dropEnd - dropStart
      arr.splice(dropStart, pairSize)
      dropped += pairSize
      current = await measure()
    }

    process.stderr.write(
      `[context-cap] channel=${channelId} before=${before} after=${current} dropped=${dropped} cap=${cap}\n`,
    )
    return { before, after: current, dropped }
  }

  /**
   * COST-06 (Phase 61): accurate token count using the provider's native
   * counter when available. Replaces getTokenEstimate char/4 for cap
   * enforcement (COST-07) and contextSizeTokens measurement (COST-08).
   * getTokenEstimate kept for backward compat — stripToolResults etc. still
   * use the fast heuristic.
   *
   * Behavior:
   *   - Empty channel → 0 (no provider call)
   *   - provider lacks countTokens → warn-once + fall through to getTokenEstimate
   *   - provider countTokens throws → log + fall through to getTokenEstimate
   */
  async countTokensWithProvider(channelId: string, provider: Provider): Promise<number> {
    const arr = this.sessions.get(channelId)
    if (!arr || arr.length === 0) return 0
    if (typeof provider.countTokens !== 'function') {
      warnOnceUnsupported(channelId, provider.name)
      return this.getTokenEstimate(channelId)
    }
    try {
      return await provider.countTokens([...arr])
    } catch (err) {
      process.stderr.write(
        `[count-tokens] provider=${provider.name} failed for channel=${channelId}: ${err instanceof Error ? err.message : String(err)}; falling through to char/4\n`,
      )
      return this.getTokenEstimate(channelId)
    }
  }

  /**
   * Phase 57 (STRIP-02, D-17, D-19): in-place rewrite removing tool_use
   * and tool_result blocks from old turns. Last keepTailTurns raw entries
   * preserved verbatim. Already-compressed messages skipped (re-compression
   * guard). Returns before/after token estimates and count of messages rewritten.
   *
   * Internal Map mutation is the documented exception (matches existing FIFO
   * splice pattern). keepTailTurns counts raw Message[] entries, NOT Discord
   * round-trip pairs (D-17).
   */
  stripToolResults(channelId: string, keepTailTurns: number = 4): {
    tokensBefore: number
    tokensAfter: number
    turnsStripped: number
  } {
    const tokensBefore = this.getTokenEstimate(channelId)
    const arr = this.sessions.get(channelId)
    if (!arr || arr.length <= keepTailTurns) {
      return { tokensBefore, tokensAfter: tokensBefore, turnsStripped: 0 }
    }
    const stripUntil = arr.length - keepTailTurns
    let turnsStripped = 0
    for (let i = 0; i < stripUntil; i++) {
      const msg = arr[i]
      if (msg.compressed === true) continue
      if (typeof msg.content !== 'object' || msg.content === null) {
        // String content has no tool blocks — nothing to strip
        continue
      }
      const blocks = msg.content as ContentBlock[]
      let rewritten = false
      let newBlocks: ContentBlock[]
      if (msg.role === 'assistant') {
        // Drop tool_use blocks; preserve everything else
        newBlocks = blocks.filter(b => b.type !== 'tool_use')
        if (newBlocks.length !== blocks.length) rewritten = true
      } else if (msg.role === 'user') {
        // Replace tool_result blocks with placeholder text
        newBlocks = blocks.map(b => {
          if (b.type === 'tool_result') {
            rewritten = true
            return { type: 'text' as const, text: '[tool_result stripped]' }
          }
          return b
        })
      } else {
        continue
      }
      if (rewritten) {
        arr[i] = { ...msg, content: newBlocks, compressed: true }
        turnsStripped++
      }
    }
    const tokensAfter = this.getTokenEstimate(channelId)
    return { tokensBefore, tokensAfter, turnsStripped }
  }

  private ensure(channelId: string): Message[] {
    let arr = this.sessions.get(channelId)
    if (!arr) {
      arr = []
      this.sessions.set(channelId, arr)
    }
    return arr
  }

  private truncate(arr: Message[]): void {
    const cap = this.maxTurns * 2
    if (arr.length > cap) {
      arr.splice(0, arr.length - cap)
    }
  }
}
