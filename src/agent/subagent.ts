import type { Provider, Message, APIToolSchema, TurnUsage } from '../providers/types.js'
import type { ToolContext } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { HookConfig } from '../hooks/index.js'
import { runAgentLoop, type LoopOptions } from './loop.js'
import type { ExitReason } from '../agent-runner/caps.js'
import { probeSandbox } from '../security/sandbox-probe.js'

export interface SubagentParent {
  provider: Provider
  registry: ToolRegistry
  apiSchemas: APIToolSchema[]
  toolContext: ToolContext
  temperature: number
  windowSize: number
  maxIterations: number
  hooks?: HookConfig
  /**
   * Phase 56 (POOL-01): static prefix string shared across workers in a
   * single orchestration run. When present, consumers prepend it to the
   * system prompt and (for Anthropic) mark it as cacheable.
   * BUD-03: flows through SubagentParent, never via module-level cache.
   */
  staticContext?: string
  /**
   * Phase 57 (MEAS-01): per-turn correlation UUID assigned by Discord
   * enqueue closure. CLI and agent-runner paths leave this undefined.
   * Flows into StreamOptions.turnId so RouterProvider can cache its
   * per-turn decision (D-01).
   */
  turnId?: string
  /**
   * Phase 59 (D-12): Mutable router session accumulator. RouterProvider
   * (Discord-only path) writes `routedTo` on its per-turn decision and
   * accumulates `classifierTokens` across classifier calls. src/discord/runner.ts
   * sets this object in the enqueue closure and reads it in the finally-block
   * aggregator to populate TurnSummaryRecord.layerBreakdown.
   *
   * CLI and agent-runner paths leave this undefined — RouterProvider is never
   * in their provider chain per ROUTE-06.
   */
  routerSession?: {
    routedTo?: import('../config/types.js').IntentClass
    /**
     * Phase 59.1 (FIX-ROUTER-03, D-04): Plain model ID of the provider the Router
     * routed this turn to (e.g. 'glm-4.7-flash', 'glm-4.6'). Set at the same
     * RouterProvider decision site as routedTo. Consumed by runner.ts via
     * nullish-coalesce `routerSession?.routedModel ?? deps.model` for pricing
     * and turn_summary.model correctness.
     */
    routedModel?: string
    classifierTokens?: number
  }
  /**
   * Phase 60 (DISPATCH-07): preloaded conversation history for
   * auto-dispatched orchestration. When set, orchestration workers
   * receive this snapshot instead of reading live ConversationManager
   * — prevents double-compression and mid-run context drift.
   *
   * Caller (runner.ts handleAutoDispatch) produces this via
   * `structuredClone(conversations.getHistory(channelId))` at dispatch time
   * per D-08. Undefined on all non-auto-dispatch paths (CLI, agent-runner,
   * explicit !orchestrate command) — preserves backward compatibility.
   */
  initialContext?: Message[]
}

export interface SubagentOverrides {
  provider?: Provider
  registry?: ToolRegistry
  apiSchemas?: APIToolSchema[]
  systemPrompt?: string
  maxIterations?: number
  /**
   * Phase 22 (AGENT-01) Wave 2: forward hard caps + exit callback into the
   * inner LoopOptions. All optional — Phase 13 callers (task tool) ignore
   * these, so signatures remain backward-compatible.
   */
  maxWallClockMs?: number
  maxTotalTokens?: number
  onExit?: (reason: ExitReason) => void
  /**
   * Phase 31 (DISC-01): prepend prior conversation context before the
   * current prompt message. Enables multi-turn Discord conversations by
   * injecting the channel history into every agent invocation.
   * When absent, behavior is unchanged (single user message as before).
   */
  initialMessages?: Message[]
  /**
   * Phase 32 (DISC-05): streaming callback forwarded to LoopCallbacks.onTextChunk.
   * When present, replaces the no-op stub so callers can receive streamed tokens.
   */
  onTextChunk?: (chunk: string) => void
  /**
   * Phase 35 (TOKEN-01): forwarded to LoopCallbacks.onTurnComplete.
   * When present, replaces the no-op stub so callers receive per-turn token usage.
   */
  onTurnComplete?: (usage: TurnUsage) => void
}

export interface SubagentResult {
  text: string
  messages: Message[]
  error: Error | null
}

/**
 * Run an isolated subagent loop with a fresh message array.
 *
 * The subagent inherits provider/registry/context from the parent by default,
 * but specific fields can be overridden per call. The parent's message array
 * is never touched. Errors from the inner loop are captured into the result
 * rather than thrown.
 */
export async function runSubagent(
  parent: SubagentParent,
  prompt: string,
  overrides: SubagentOverrides = {},
  systemPrompt?: string,
): Promise<SubagentResult> {
  // Phase 62 (SAND-02, BACKLOG 999.15): fail-loud sandbox probe before any
  // tool dispatches. Catches silent '/' CWD and empty-HOME conditions that
  // caused 17 production write_todos EROFS failures. Emits sandbox_probe
  // audit row on pass/fail regardless of outcome.
  const probe = probeSandbox({ sessionId: parent.toolContext.sessionId })
  if (!probe.pass) {
    return {
      text: '',
      messages: [],
      error: new Error(
        `sandbox_probe failed: ${probe.reason ?? 'unknown'} (home='${probe.home}', cwd='${probe.cwd}'). See SAND-02 / BACKLOG 999.15.`,
      ),
    }
  }

  const messages: Message[] = [
    ...(overrides.initialMessages ?? []),
    { role: 'user', content: prompt },
  ]

  const provider = overrides.provider ?? parent.provider
  const registry = overrides.registry ?? parent.registry
  const apiSchemas = overrides.apiSchemas ?? parent.apiSchemas
  const effectiveSystemPrompt = overrides.systemPrompt ?? systemPrompt

  const loopOptions: LoopOptions = {
    provider,
    tools: registry.getAll(),
    registry,
    apiSchemas,
    maxIterations: overrides.maxIterations ?? parent.maxIterations,
    maxWallClockMs: overrides.maxWallClockMs,
    maxTotalTokens: overrides.maxTotalTokens,
    onExit: overrides.onExit,
    temperature: parent.temperature,
    windowSize: parent.windowSize,
    toolContext: parent.toolContext,
    systemPrompt: effectiveSystemPrompt,
    hooks: parent.hooks,
    turnId: parent.turnId,                   // Phase 59 (D-10): undefined on CLI/agent-runner paths
    routerSession: parent.routerSession,     // Phase 59 (D-12): undefined on CLI/agent-runner paths
    callbacks: {
      onTextChunk: overrides.onTextChunk ?? (() => {}),
      onToolCall: () => {},
      onToolResult: () => {},
      onTurnComplete: overrides.onTurnComplete ?? (() => {}),
    },
  }

  try {
    await runAgentLoop(messages, loopOptions)
  } catch (err) {
    return {
      text: '',
      messages,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }

  // Walk backwards to find last assistant message with non-null content
  let text = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) {
      text = m.content
      break
    }
  }

  return { text, messages, error: null }
}
