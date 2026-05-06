import OpenAI from 'openai'
import { encode } from 'gpt-tokenizer'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions.js'
import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse, TurnUsage } from './types.js'
import { StreamAbortError } from './types.js'

interface OpenAICompatConfig {
  apiKey?: string
  baseURL?: string
  model: string
  isOllama?: boolean
}

/** Extract textual representation from a Message for tokenization (COST-06). */
function messageToString(m: Message): string {
  if (m.content == null) return ''
  if (typeof m.content === 'string') return m.content
  const parts: string[] = []
  for (const block of m.content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

export class OpenAICompatProvider implements Provider {
  readonly name = 'openai-compat'
  private client: OpenAI
  private model: string
  private isOllama: boolean

  constructor(config: OpenAICompatConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'ollama',
      baseURL: config.baseURL,
    })
    this.model = config.model
    this.isOllama = config.isOllama ?? false
  }

  /**
   * COST-06 (Phase 61): local token count via gpt-tokenizer (cl100k_base).
   * gpt-tokenizer covers GPT-3.5/4-era encoding; Z.ai GLM + DeepSeek report
   * cl100k-compatible counts within ~5% for most workloads. On error, writes
   * a [count-tokens] stderr warning and falls through to char/4 heuristic —
   * callers see a usable number instead of a thrown error.
   *
   * Note: NOT using @dqbd/tiktoken o200k_base because the package isn't in
   * the project deps and adding it would require a Bun-compat check for its
   * native WASM bindings. gpt-tokenizer is already loaded (router classifier
   * input-capping path), so reuse keeps surface area minimal. Accuracy delta
   * vs o200k_base documented in 61-05-SUMMARY.md.
   */
  async countTokens(messages: Message[]): Promise<number> {
    if (messages.length === 0) return 0
    try {
      let total = 0
      for (const m of messages) {
        const text = messageToString(m)
        if (text.length > 0) total += encode(text).length
      }
      return total
    } catch (err) {
      process.stderr.write(
        `[count-tokens] gpt-tokenizer failed for model=${this.model}; falling through to char/4 heuristic (${err instanceof Error ? err.message : String(err)})\n`,
      )
      let chars = 0
      for (const m of messages) chars += messageToString(m).length
      return Math.ceil(chars / 4)
    }
  }

  async stream(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
  ): Promise<StreamResponse> {
    const { onTextChunk, systemPrompt, maxTokens, temperature, responseFormat, thinking } = opts

    // Convert messages to OpenAI format
    const openaiMessages: ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      openaiMessages.push({ role: 'system', content: systemPrompt })
    }

    const asString = (c: typeof messages[number]['content']): string => {
      if (c == null) return ''
      if (typeof c === 'string') return c
      return c.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages in the array go before others, skip if we already added systemPrompt
        if (!systemPrompt) {
          openaiMessages.push({ role: 'system', content: asString(msg.content) })
        }
        continue
      }

      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          // Multimodal user message — image_url with data URLs
          const parts: Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          > = []
          for (const b of msg.content) {
            if (b.type === 'text') {
              parts.push({ type: 'text', text: b.text })
            } else if (b.type === 'image') {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${b.source.mediaType};base64,${b.source.data}`,
                },
              })
            }
          }
          openaiMessages.push({ role: 'user', content: parts as unknown as string })
        } else {
          openaiMessages.push({ role: 'user', content: msg.content ?? '' })
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          openaiMessages.push({
            role: 'assistant',
            content: typeof msg.content === 'string' ? msg.content : (msg.content == null ? null : asString(msg.content)),
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          })
        } else {
          openaiMessages.push({
            role: 'assistant',
            content: asString(msg.content),
          })
        }
      } else if (msg.role === 'tool') {
        openaiMessages.push({
          role: 'tool',
          content: asString(msg.content),
          tool_call_id: msg.toolCallId ?? '',
        })
      }
    }

    // Convert tools to OpenAI format, filter out server tools (web_search)
    const regularTools = tools.filter((t) => !t.isServerTool)
    const openaiTools: ChatCompletionTool[] = regularTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    // Ollama with tools: use non-streaming to avoid streaming bugs
    const useStream = !(this.isOllama && regularTools.length > 0)

    let accumulatedText = ''
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; args: string }
    >()

    // Phase 59.1-02 (FIX-ROUTER-02): `thinking` is a Z.ai-specific param not in
    // the OpenAI SDK type. Bun's fetch forwards extra body fields verbatim, so
    // we cast the composed params to bypass the SDK's stricter typing. Other
    // OpenAI-compatible endpoints (OpenAI itself, Ollama, llamacpp) will
    // harmlessly ignore the unknown field.
    const baseParams = {
      model: this.model,
      messages: openaiMessages,
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    } as Parameters<typeof this.client.chat.completions.create>[0]

    // Phase 55 (USAGE-01): best-effort partial usage.
    // OpenAI only emits usage on the final chunk (with stream_options.include_usage),
    // so inputTokens + outputTokens stay 0 until that chunk arrives. If abort
    // happens before, we honestly report zeros rather than guess.
    const partialUsage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,  // OpenAI-compat has no cache usage at all
      cacheReadTokens: 0,
    }

    if (useStream) {
      let streamResp: AsyncIterable<ChatCompletionChunk>
      try {
        streamResp = await this.client.chat.completions.create({
          ...baseParams,
          stream: true,
          stream_options: { include_usage: true },
        }) as AsyncIterable<ChatCompletionChunk>
      } catch (err) {
        throw new StreamAbortError(
          err instanceof Error ? err.message : String(err),
          partialUsage,
          err,
        )
      }

      let inputTokens = 0
      let outputTokens = 0

      try {
        for await (const chunk of streamResp) {
          const delta = chunk.choices[0]?.delta

          if (delta?.content) {
            accumulatedText += delta.content
            onTextChunk(delta.content)
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (tc.id) {
                toolCallAccumulator.set(idx, {
                  id: tc.id,
                  name: tc.function?.name ?? '',
                  args: tc.function?.arguments ?? '',
                })
              } else {
                const entry = toolCallAccumulator.get(idx)
                if (entry && tc.function?.arguments) {
                  entry.args += tc.function.arguments
                }
                if (entry && tc.function?.name) {
                  entry.name += tc.function.name
                }
              }
            }
          }

          // Usage comes in the last chunk with stream_options
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0
            outputTokens = chunk.usage.completion_tokens ?? 0
            // Update partialUsage so an abort after this chunk gets the right values
            partialUsage.inputTokens = inputTokens
            partialUsage.outputTokens = outputTokens
          }
        }
      } catch (err) {
        throw new StreamAbortError(
          err instanceof Error ? err.message : String(err),
          partialUsage,
          err,
        )
      }

      const toolCalls = buildToolCalls(toolCallAccumulator)
      const stopReason = null // We don't easily get stop_reason from streaming in openai v4

      return {
        text: accumulatedText,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        stopReason,
      }
    } else {
      // Non-streaming for Ollama + tools
      let response
      try {
        response = await this.client.chat.completions.create({
          ...baseParams,
          stream: false,
        })
      } catch (err) {
        throw new StreamAbortError(
          err instanceof Error ? err.message : String(err),
          partialUsage,
          err,
        )
      }

      const choice = response.choices[0]
      const msgContent = choice?.message?.content ?? ''
      accumulatedText = msgContent

      if (msgContent) {
        onTextChunk(msgContent)
      }

      if (choice?.message?.tool_calls) {
        for (const [idx, tc] of choice.message.tool_calls.entries()) {
          toolCallAccumulator.set(idx, {
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
          })
        }
      }

      const toolCalls = buildToolCalls(toolCallAccumulator)
      const usage = response.usage

      return {
        text: accumulatedText,
        toolCalls,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        stopReason: choice?.finish_reason ?? null,
      }
    }
  }
}

function buildToolCalls(
  accumulator: Map<number, { id: string; name: string; args: string }>,
) {
  const toolCalls = []
  for (const [, acc] of accumulator) {
    let input: Record<string, unknown> = {}
    try {
      input = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {}
    } catch {
      input = {}
    }
    toolCalls.push({ id: acc.id, name: acc.name, input })
  }
  return toolCalls
}
