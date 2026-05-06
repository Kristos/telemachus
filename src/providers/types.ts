export interface ToolCallBlock {
  id: string
  name: string
  input: Record<string, unknown>
}

// Phase 21-03: multimodal content blocks. Existing string-content paths
// remain the common case; arrays only engage when images are attached.
export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; mediaType: string; data: string }
}
export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export type ToolResultBlock = {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[] | null
  toolCalls?: ToolCallBlock[]   // on assistant messages when tool_use present
  toolCallId?: string           // on tool result messages
}

/** Extract plain text from a Message.content union. Used by consumers
 *  that only care about the textual representation (export, subagent
 *  result extraction, status display). */
export function messageText(content: string | ContentBlock[] | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface StreamResponse {
  text: string
  toolCalls: ToolCallBlock[]
  usage: TurnUsage
  stopReason: string | null
}

export interface StreamOptions {
  onTextChunk: (chunk: string) => void
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  /**
   * Phase 59 (ROUTE-01, D-09): turnId UUID from Discord enqueue closure.
   * Read ONLY by RouterProvider for per-turn decision caching (D-01).
   * CLI and agent-runner paths omit this field. Other providers
   * (Anthropic, OpenAICompat, Fallback) ignore it (D-11).
   */
  turnId?: string
  /**
   * Phase 59 prerequisite (Phase 58 COMPRESS-06 deferred):
   * structured output format. Currently only 'json_object' is supported.
   * OpenAICompatProvider forwards this to Z.ai as response_format.
   * AnthropicProvider ignores this field.
   */
  responseFormat?: { type: 'json_object' }
  /**
   * Phase 59 (D-12): mutable router session accumulator for per-turn
   * layerBreakdown. RouterProvider writes `routedTo` on decision and
   * accumulates `classifierTokens` per classifier call. Other providers
   * ignore this field. src/discord/runner.ts reads it in its finally-block
   * aggregator and merges into TurnSummaryRecord.layerBreakdown.
   */
  routerSession?: {
    routedTo?: import('../config/types.js').IntentClass
    /**
     * Phase 59.1 (FIX-ROUTER-03, D-04): Plain model ID of the provider the Router
     * routed this turn to. Written by RouterProvider at the decision site so
     * src/discord/runner.ts can feed it to resolveModelPricing and
     * finalizeTurnSummary via nullish-coalesce fallback to deps.model.
     */
    routedModel?: string
    classifierTokens?: number
  }
  /**
   * Phase 59.1-02 (FIX-ROUTER-02): Z.ai-specific escape hatch for disabling
   * GLM-4.5+ reasoning phase on a per-call basis. Only RouterProvider's
   * classifier call sets this — other callers leave it undefined. The
   * openai-compat provider passes it verbatim to Z.ai's API; other providers
   * (Anthropic, Fallback) ignore it silently per the Phase 59 D-11
   * zero-churn pattern.
   *
   * Shape mirrors Z.ai API reference:
   *   https://docs.z.ai/api-reference/llm/chat-completion
   *
   * Empirical finding (59.1-01 Task 4): GLM-4.7-Flash is a reasoning model.
   * With thinking enabled (default), it routes content through
   * `delta.reasoning_content` SSE events and consumes the entire `max_tokens`
   * budget on internal thinking BEFORE emitting any `delta.content`. Setting
   * `thinking: { type: 'disabled' }` bypasses that phase and returns direct JSON.
   */
  thinking?: { type: 'enabled' | 'disabled' }
}

export interface APIToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isServerTool?: boolean  // true for web_search — handled by provider, not by loop
}

export interface Provider {
  readonly name: string
  stream(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
  ): Promise<StreamResponse>
  /**
   * COST-06 (Phase 61): accurate token count for a given message set.
   * Optional — callers should check `typeof provider.countTokens === 'function'`
   * and fall back to char/4 when absent.
   *
   * Implementations:
   *   - AnthropicProvider: `client.beta.messages.countTokens` (network call,
   *     cache per-message-hash to amortize ~100ms latency)
   *   - OpenAICompatProvider: local `gpt-tokenizer` encode (cl100k_base)
   *   - FallbackProvider: delegates to primary, falls through to fallback on error
   *   - Unknown / local providers may warn + fall through to char/4 heuristic
   */
  countTokens?(messages: Message[]): Promise<number>
}

/**
 * Phase 55 (USAGE-01): thrown by providers when a stream aborts mid-turn.
 * Carries whatever usage was seen before the abort so the caller can still
 * account for partial spend via `onTurnComplete`. The original error is
 * preserved on `.cause` per ES2022 Error cause convention.
 *
 * Callers should do `if (err instanceof StreamAbortError) { ... err.partialUsage }`.
 */
export class StreamAbortError extends Error {
  readonly partialUsage: TurnUsage
  constructor(message: string, partialUsage: TurnUsage, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'StreamAbortError'
    this.partialUsage = partialUsage
  }
}
