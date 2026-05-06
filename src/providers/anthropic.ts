import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  ContentBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages.js'
import { createHash } from 'node:crypto'
import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse, TurnUsage } from './types.js'
import { StreamAbortError } from './types.js'
import { attachSystemCache, maybeCacheToolsArray } from './anthropic-cache.js'

/** Hash a message set for Anthropic countTokens cache key (COST-06). */
function hashMessages(messages: Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  private client: Anthropic
  /**
   * COST-06 (Phase 61): bounded cache keyed by sha256(JSON.stringify(messages)).
   * Amortizes the ~100ms network call for repeat counts within a turn —
   * ConversationManager may re-count the same channel history during budget
   * check + pre-runSubagent measurement + post-stripping validation.
   * FIFO eviction at 256 entries to bound memory.
   */
  private tokenCountCache = new Map<string, number>()

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey })
  }

  /**
   * COST-06 (Phase 61): accurate input-token count via Anthropic beta endpoint.
   * Cache per-message-set hash to bound repeat network calls.
   */
  async countTokens(messages: Message[]): Promise<number> {
    const key = hashMessages(messages)
    const cached = this.tokenCountCache.get(key)
    if (cached !== undefined) return cached

    // Build a minimal Anthropic message shape. We pass the full messages array
    // through the beta endpoint; the Anthropic SDK handles shape normalization.
    // Only text content is counted here — parity with stream() which converts
    // the same way. On non-text blocks, fall through to JSON.stringify.
    const anthropicMessages: MessageParam[] = []
    for (const msg of messages) {
      if (msg.role === 'system') continue // system passed separately in stream; skip here
      const role = msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant')
      if (typeof msg.content === 'string') {
        anthropicMessages.push({ role, content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const blocks: ContentBlockParam[] = []
        for (const b of msg.content) {
          if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
          else blocks.push({ type: 'text', text: JSON.stringify(b) })
        }
        anthropicMessages.push({ role, content: blocks })
      } else {
        anthropicMessages.push({ role, content: '' })
      }
    }

    const result = await this.client.beta.messages.countTokens({
      model: this.model,
      messages: anthropicMessages,
    })
    const count = result.input_tokens
    this.tokenCountCache.set(key, count)
    // Bound cache size — simple FIFO eviction at 256 entries.
    if (this.tokenCountCache.size > 256) {
      const firstKey = this.tokenCountCache.keys().next().value
      if (firstKey !== undefined) this.tokenCountCache.delete(firstKey)
    }
    return count
  }

  async stream(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
  ): Promise<StreamResponse> {
    const { onTextChunk, systemPrompt, maxTokens = 16384, temperature } = opts

    // Convert messages to Anthropic format
    const anthropicMessages: MessageParam[] = []
    for (const msg of messages) {
      if (msg.role === 'system') continue // handled separately as system param

      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const blocks: ContentBlockParam[] = []
          for (const b of msg.content) {
            if (b.type === 'text') {
              blocks.push({ type: 'text', text: b.text })
            } else if (b.type === 'image') {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: b.source.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: b.source.data,
                },
              })
            }
          }
          anthropicMessages.push({ role: 'user', content: blocks })
        } else {
          anthropicMessages.push({
            role: 'user',
            content: msg.content ?? '',
          })
        }
      } else if (msg.role === 'assistant') {
        const content: ContentBlockParam[] = []
        if (msg.content) {
          if (typeof msg.content === 'string') {
            content.push({ type: 'text', text: msg.content })
          } else {
            for (const b of msg.content) {
              if (b.type === 'text') content.push({ type: 'text', text: b.text })
            }
          }
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })
          }
        }
        anthropicMessages.push({ role: 'assistant', content })
      } else if (msg.role === 'tool') {
        // Tool result — find last message and append, or create new user message
        const lastMsg = anthropicMessages[anthropicMessages.length - 1]
        const toolResultBlock: ContentBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: typeof msg.content === 'string' ? msg.content : '',
        }
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          ;(lastMsg.content as ContentBlockParam[]).push(toolResultBlock)
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultBlock],
          })
        }
      }
    }

    // Separate regular tools from server tools
    const regularTools = tools.filter((t) => !t.isServerTool)
    const hasServerTools = tools.some((t) => t.isServerTool)

    const convertedTools: AnthropicTool[] = regularTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as AnthropicTool['input_schema'],
    }))

    // Accumulator for tool calls: Map<blockIndex, { id, name, args }>
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>()
    let accumulatedText = ''

    // Phase 64 (CACHE-01): wrap systemPrompt in a cache_control block array
    // when it exceeds the model-specific threshold so the Anthropic API caches
    // the system + tools bundle across CLI turns within the 5-minute ephemeral TTL.
    const systemField = systemPrompt
      ? attachSystemCache(systemPrompt, this.model)
      : undefined
    const streamParams = {
      model: this.model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(systemField !== undefined ? { system: systemField } : {}),
      messages: anthropicMessages,
    }

    // Phase 55 (USAGE-01): accumulate partial usage from message_start + message_delta
    // events so that if the stream aborts we can still report what was billed.
    const partialUsage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }

    let finalMessage: Anthropic.Message

    if (hasServerTools) {
      // Use beta API for web_search server tool
      const betaTools = [
        ...convertedTools,
        {
          type: 'web_search_20250305' as const,
          name: 'web_search' as const,
          max_uses: 8,
        },
      ]

      // Phase 64 (CACHE-02): attach cache_control to last tool (web_search) when
      // combined serialized tools size exceeds model threshold. Anthropic treats
      // the breakpoint as "everything up to and including this block" cacheable —
      // so the system + all tools cache together as one unit.
      const cachedBetaTools = maybeCacheToolsArray(betaTools, this.model)

      const betaStream = await this.client.beta.messages.stream({
        ...streamParams,
        tools: cachedBetaTools,
        betas: ['web-search-2025-03-05'],
      })

      try {
        for await (const event of betaStream) {
          // Phase 55: capture partial usage from lifecycle events.
          if (event.type === 'message_start') {
            const usage = (event as unknown as { message?: { usage?: {
              input_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            } } }).message?.usage
            if (usage) {
              partialUsage.inputTokens = usage.input_tokens ?? 0
              partialUsage.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
              partialUsage.cacheReadTokens = usage.cache_read_input_tokens ?? 0
            }
          } else if (event.type === 'message_delta') {
            const usage = (event as unknown as { usage?: { output_tokens?: number } }).usage
            if (usage?.output_tokens !== undefined) {
              partialUsage.outputTokens = usage.output_tokens
            }
          } else if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              toolCallAccumulator.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: '',
              })
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              accumulatedText += event.delta.text
              onTextChunk(event.delta.text)
            } else if (event.delta.type === 'input_json_delta') {
              const entry = toolCallAccumulator.get(event.index)
              if (entry) {
                entry.args += event.delta.partial_json
              }
            }
          }
        }

        // Beta stream returns ParsedBetaMessage which has extra fields (caller variants)
        // that don't exist on the standard Message type. Safe to cast — we only read
        // content, usage, and stop_reason which are identical across both.
        finalMessage = await betaStream.finalMessage() as unknown as Anthropic.Message
      } catch (err) {
        throw new StreamAbortError(
          err instanceof Error ? err.message : String(err),
          partialUsage,
          err,
        )
      }
    } else {
      // Standard API
      // Phase 64 (CACHE-02): tools cache breakpoint on last tool when combined
      // serialized size exceeds threshold (see beta path comment above).
      const cachedTools = maybeCacheToolsArray(convertedTools, this.model)
      const stdStream = await this.client.messages.stream({
        ...streamParams,
        tools: cachedTools,
      })

      try {
        for await (const event of stdStream) {
          // Phase 55: capture partial usage from lifecycle events.
          if (event.type === 'message_start') {
            const usage = (event as unknown as { message?: { usage?: {
              input_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            } } }).message?.usage
            if (usage) {
              partialUsage.inputTokens = usage.input_tokens ?? 0
              partialUsage.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
              partialUsage.cacheReadTokens = usage.cache_read_input_tokens ?? 0
            }
          } else if (event.type === 'message_delta') {
            const usage = (event as unknown as { usage?: { output_tokens?: number } }).usage
            if (usage?.output_tokens !== undefined) {
              partialUsage.outputTokens = usage.output_tokens
            }
          } else if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              toolCallAccumulator.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: '',
              })
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              accumulatedText += event.delta.text
              onTextChunk(event.delta.text)
            } else if (event.delta.type === 'input_json_delta') {
              const entry = toolCallAccumulator.get(event.index)
              if (entry) {
                entry.args += event.delta.partial_json
              }
            }
          }
        }

        finalMessage = await stdStream.finalMessage()
      } catch (err) {
        throw new StreamAbortError(
          err instanceof Error ? err.message : String(err),
          partialUsage,
          err,
        )
      }
    }

    // Parse accumulated tool calls
    const toolCalls = []
    for (const [, acc] of toolCallAccumulator) {
      let input: Record<string, unknown> = {}
      try {
        input = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {}
      } catch {
        input = {}
      }
      toolCalls.push({ id: acc.id, name: acc.name, input })
    }

    const usage = finalMessage.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }

    return {
      text: accumulatedText,
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      },
      stopReason: finalMessage.stop_reason ?? null,
    }
  }
}
