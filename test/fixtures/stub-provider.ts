/**
 * Phase 22 (AGENT-01) — test fixture: a pure in-memory Provider.
 *
 * No network. Each `stream()` call pops the next scripted response off a
 * queue. When the queue empties the stub returns a natural-termination
 * response (`text: 'done'`, no tool calls), which matches how a real model
 * would end a turn.
 *
 * Exposed for assertions:
 *   - `callCount`  — how many times stream() has been invoked
 *   - the stub honors `onTextChunk` (emits the full text in one chunk) so
 *     the loop's text-streaming code path gets exercised.
 */
import type {
  Provider,
  Message,
  APIToolSchema,
  StreamOptions,
  StreamResponse,
  TurnUsage,
  ToolCallBlock,
} from '../../src/providers/types.js'

export interface StubResponse {
  text?: string
  toolCalls?: ToolCallBlock[]
  usage?: TurnUsage
  stopReason?: string | null
}

export interface StubProviderOptions {
  responses: StubResponse[]
  /** Default usage when a response omits it. */
  defaultUsage?: TurnUsage
  /** Provider name surfaced to the loop. Defaults to 'stub'. */
  name?: string
}

export interface StubProvider extends Provider {
  callCount: number
  /** Full list of (messages, tools, opts) arguments received across calls. */
  calls: Array<{ messages: Message[]; tools: APIToolSchema[]; opts: StreamOptions }>
}

const DEFAULT_USAGE: TurnUsage = {
  inputTokens: 10,
  outputTokens: 10,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
}

export function createStubProvider(opts: StubProviderOptions): StubProvider {
  const queue: StubResponse[] = [...opts.responses]
  const calls: StubProvider['calls'] = []
  const defaultUsage = opts.defaultUsage ?? DEFAULT_USAGE

  const stub: StubProvider = {
    name: opts.name ?? 'stub',
    callCount: 0,
    calls,
    async stream(
      messages: Message[],
      tools: APIToolSchema[],
      streamOpts: StreamOptions,
    ): Promise<StreamResponse> {
      stub.callCount++
      calls.push({ messages, tools, opts: streamOpts })

      const next = queue.shift() ?? { text: 'done', toolCalls: [] }
      const text = next.text ?? ''
      const toolCalls = next.toolCalls ?? []

      // Exercise the onTextChunk callback so downstream stream-consumers
      // get the same code path as a real provider.
      if (text.length > 0) {
        try {
          streamOpts.onTextChunk(text)
        } catch {
          // swallow — the stub must never crash the loop via a callback.
        }
      }

      return {
        text,
        toolCalls,
        usage: next.usage ?? defaultUsage,
        stopReason: next.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
      }
    },
  }
  return stub
}
