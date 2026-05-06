import type { Provider, Message, APIToolSchema, TurnUsage } from '../providers/types.js'
import { StreamAbortError } from '../providers/types.js'
import type { Tool, ToolContext } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import { truncateResult } from '../utils/truncate.js'
import { applyWindow } from './window.js'
import {
  matchHooks,
  runHooks,
  type HookConfig,
  type HookEvent,
  type HookRunResult,
} from '../hooks/index.js'
import { getTier, setCliTierOverride } from '../security/trust-tiers.js'
import type { TrustTier } from '../security/trust-tiers.js'
import { hashArgs, appendAuditEntry, type SandboxStatus } from '../security/audit.js'
import { classifyError } from '../security/error-classifier.js'
import { recordError as recordToolError } from '../security/tool-error-metrics.js'
import { registeredCliToolNames, registeredCliToolConfigs } from '../cli-tools/register.js'
import { validateArgString } from '../cli-tools/validate.js'
import { parseArgString } from '../cli-tools/parse-args.js'
import { resolveSubCommandTier } from '../cli-tools/resolve-tier.js'
import { buildCommandSummary } from '../cli-tools/dispatch.js'
import type { McpManager } from '../mcp/manager.js'
import { computeToolSchemaTokens, recordSchemaCost } from '../usage/tracker.js'
import { checkCaps, type ExitReason } from '../agent-runner/caps.js'

export interface LoopCallbacks {
  onTextChunk: (chunk: string) => void
  onToolCall: (id: string, name: string, args: unknown) => void
  onToolResult: (id: string, name: string, result: string, isError: boolean) => void
  onTurnComplete: (usage: TurnUsage) => void
  onHookWarning?: (event: HookEvent, toolName: string, results: HookRunResult[]) => void
}

export interface LoopOptions {
  provider: Provider
  tools: Tool[]
  registry: ToolRegistry
  apiSchemas: APIToolSchema[]
  maxIterations: number
  temperature: number
  windowSize: number
  toolContext: ToolContext
  callbacks: LoopCallbacks
  systemPrompt?: string
  hooks?: HookConfig
  mcpManager?: McpManager
  /**
   * Phase 22 (AGENT-01): hard caps for headless runs. All optional —
   * absent = no limit. Interactive sessions leave these undefined and
   * retain pre-v1.5 behavior (only maxIterations applies).
   */
  maxWallClockMs?: number
  maxTotalTokens?: number
  /**
   * Phase 22 (AGENT-01): called exactly once when the loop exits, with
   * the reason. Fires for both natural termination and cap hits.
   * Hard-cap exits return BEFORE the existing Stop-hooks block (Stop
   * hooks can themselves consume wall-clock), so subscribers should not
   * assume Stop hooks have already run.
   */
  onExit?: (reason: ExitReason) => void
  /**
   * Phase 59 (D-09, D-10): per-turn correlation UUID from Discord enqueue
   * closure. Undefined on CLI and agent-runner paths. Forwarded into every
   * StreamOptions literal so RouterProvider can access it.
   */
  turnId?: string
  /**
   * Phase 59 (D-12): mutable router session accumulator. Passed by
   * reference into StreamOptions so RouterProvider can mutate it in-place
   * to record routing decisions and classifier token usage.
   * Undefined on CLI and agent-runner paths.
   */
  routerSession?: {
    routedTo?: import('../config/types.js').IntentClass
    /**
     * Phase 59.1 (FIX-ROUTER-03, D-04): Plain model ID of the provider the Router
     * routed this turn to. Flows from SubagentParent → LoopOptions → StreamOptions
     * and is written by RouterProvider at the decision site. Runner.ts reads the
     * same mutable object via the closure and nullish-coalesces to deps.model.
     */
    routedModel?: string
    classifierTokens?: number
  }
}

export async function runAgentLoop(
  messages: Message[],
  opts: LoopOptions,
): Promise<void> {
  const hooks: HookConfig = opts.hooks ?? {}
  const loopStartedAt = Date.now()
  let totalTokens = 0
  // Phase 22 (AGENT-01): iteration control is delegated to checkCaps so
  // `maxIterations`, `maxWallClockMs`, and `maxTotalTokens` share one code
  // path. The legacy `for` ceiling would exit one turn too late for the
  // iteration cap (it fires on the NEXT attempted turn, not after the Nth).
  let iteration = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Phase 22 (AGENT-01): hard-cap check at iteration head.
    // Hard-cap exits skip the trailing Stop-hooks block because Stop hooks
    // may themselves consume wall-clock time, which would defeat the cap.
    const capReason = checkCaps(
      { iterations: iteration, startedAt: loopStartedAt, totalTokens },
      {
        maxIterations: opts.maxIterations,
        maxWallClockMs: opts.maxWallClockMs,
        maxTotalTokens: opts.maxTotalTokens,
      },
    )
    if (capReason !== null) {
      opts.onExit?.(capReason)
      return
    }
    // Record per-turn tool-schema context attribution (builtin vs mcp/<server>)
    // so /cost can surface which MCP servers are eating the context window.
    recordSchemaCost(computeToolSchemaTokens(opts.registry.getAll()))

    // Apply sliding window — provider only sees the last N messages
    // but the full history array keeps growing (for session persistence later)
    const windowed = applyWindow(messages, opts.windowSize)

    let response
    try {
      response = await opts.provider.stream(windowed, opts.apiSchemas, {
        onTextChunk: opts.callbacks.onTextChunk,
        systemPrompt: opts.systemPrompt,
        temperature: opts.temperature,
        ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
        ...(opts.routerSession !== undefined ? { routerSession: opts.routerSession } : {}),
      })
    } catch (err) {
      // Phase 55 (USAGE-01): record partial usage on stream abort so /cost
      // reflects what was actually billed. Only fires for StreamAbortError —
      // plain errors (e.g. thrown synchronously before any stream event)
      // have no usage to record.
      if (err instanceof StreamAbortError) {
        opts.callbacks.onTurnComplete(err.partialUsage)
      }
      throw err
    }

    // Push to the FULL history, not the windowed slice
    messages.push({
      role: 'assistant',
      content: response.text || null,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    })

    // Phase 22 (AGENT-01): accumulate tokens for the token cap.
    // Only input+output count — cache tokens are model-side billing
    // artifacts, not "work done" from the agent's perspective.
    totalTokens += (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0)

    opts.callbacks.onTurnComplete(response.usage)

    if (response.toolCalls.length === 0) {
      break
    }

    for (const toolCall of response.toolCalls) {
      opts.callbacks.onToolCall(toolCall.id, toolCall.name, toolCall.input)

      // MCP dispatch hook — ensure server is alive before resolving the tool.
      if (opts.mcpManager && toolCall.name.startsWith('mcp__')) {
        const serverName = toolCall.name.split('__')[1] ?? ''
        try {
          await opts.mcpManager.ensureAlive(serverName)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const errContent = `MCP server '${serverName}' unavailable: ${errMsg}`
          opts.callbacks.onToolResult(toolCall.id, toolCall.name, errContent, true)
          messages.push({
            role: 'tool',
            content: errContent,
            toolCallId: toolCall.id,
          })
          continue
        }
      }

      const tool = opts.registry.find(toolCall.name)

      if (!tool) {
        const errContent = `Unknown tool: ${toolCall.name}`
        opts.callbacks.onToolResult(toolCall.id, toolCall.name, errContent, true)
        messages.push({
          role: 'tool',
          content: errContent,
          toolCallId: toolCall.id,
        })
        continue
      }

      if (tool.isServerTool) {
        continue
      }

      // Phase 20 (LEAN-02) — CLI tool pre-processing.
      // For registered cli:<name> tools we:
      //  1. Validate the arg string up-front — metachar reject short-circuits
      //     the whole flow (no permission prompt, no spawn, no audit entry)
      //  2. Parse argv + resolve the sub-command tier (longest-prefix first)
      //  3. Stash a clean command summary on the input so the permission prompt
      //     shows `Run gh pr list?` (decision 9), not the full arg string
      //  4. Inject the resolved tier into cliTierOverrides under the bare tool
      //     name so the downstream checkPermission → getTier flow sees it
      let cliPreResolvedTier: TrustTier | null = null
      let cliPermissionInput: unknown = toolCall.input
      if (registeredCliToolNames.has(toolCall.name)) {
        const cfg = registeredCliToolConfigs.get(toolCall.name)!
        const inputObj = toolCall.input as Record<string, unknown> | null
        const rawArgs = typeof inputObj?.args === 'string' ? inputObj.args : ''
        const rejectReason = validateArgString(rawArgs)
        if (rejectReason) {
          const errContent = `Rejected arg: ${rejectReason}`
          opts.callbacks.onToolResult(toolCall.id, toolCall.name, errContent, true)
          messages.push({
            role: 'tool',
            content: errContent,
            toolCallId: toolCall.id,
          })
          continue
        }
        const argv = parseArgString(rawArgs)
        cliPreResolvedTier = resolveSubCommandTier(argv, cfg)
        const summary = buildCommandSummary(cfg.command, argv)
        cliPermissionInput = { ...(inputObj ?? {}), __cliCommandSummary: summary }
        // Inject resolved tier so downstream getTier(toolCall.name) picks it up.
        // The loop is sequential per turn, so repeated overwrites are safe.
        setCliTierOverride(toolCall.name, cliPreResolvedTier)
      }

      // Permission gate — check before executing
      if (opts.toolContext.checkPermission) {
        const permitted = await opts.toolContext.checkPermission(toolCall.name, cliPermissionInput)
        if (permitted === 'deny') {
          const errContent = `Tool '${toolCall.name}' execution denied.`
          opts.callbacks.onToolResult(toolCall.id, toolCall.name, errContent, true)
          messages.push({
            role: 'tool',
            content: errContent,
            toolCallId: toolCall.id,
          })
          continue
        }
      }

      // PreToolUse hooks — after permission gate, before execute
      const preCmds = matchHooks('PreToolUse', toolCall.name, hooks)
      if (preCmds.length > 0) {
        let preResults: HookRunResult[] = []
        try {
          preResults = await runHooks('PreToolUse', toolCall.name, preCmds)
        } catch {
          preResults = []
        }
        const blocking = preResults.find((r) => r.blocked)
        const failed = preResults.filter((r) => r.exitCode !== 0 || r.timedOut)
        if (failed.length > 0) {
          opts.callbacks.onHookWarning?.('PreToolUse', toolCall.name, failed)
        }
        if (blocking) {
          const detail = (blocking.stderr.trim() || blocking.stdout.trim() || (blocking.timedOut ? 'timed out' : ''))
          const errContent = `Tool '${toolCall.name}' blocked by PreToolUse hook (exit ${blocking.exitCode}): ${detail}`
          opts.callbacks.onToolResult(toolCall.id, toolCall.name, errContent, true)
          messages.push({
            role: 'tool',
            content: errContent,
            toolCallId: toolCall.id,
          })
          continue
        }
      }

      const tier = getTier(toolCall.name)
      const argsHashValue = hashArgs(toolCall.input)
      const startedAt = Date.now()

      let result: {
        content: string
        isError: boolean
        __sandboxStatus?: SandboxStatus
        __resolvedTier?: TrustTier
        __commandSummary?: string
        __auditPromise?: Promise<void>
      }
      const mcpServerName = toolCall.name.startsWith('mcp__') ? (toolCall.name.split('__')[1] ?? '') : ''
      if (mcpServerName && opts.mcpManager) opts.mcpManager.incrementPending(mcpServerName)
      // Phase 63 (OBS-01): capture the thrown value so we can classify it on
      // the tool_error emission path below. null = tool returned {isError}
      // without throwing; see isError branch emission for that case.
      let capturedErr: unknown = null
      try {
        result = await tool.execute(toolCall.input, opts.toolContext)
      } catch (err) {
        capturedErr = err
        result = {
          content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      } finally {
        if (mcpServerName && opts.mcpManager) {
          opts.mcpManager.decrementPending(mcpServerName)
          opts.mcpManager.touch(mcpServerName)
        }
      }

      // Read and strip hidden dispatch fields before forwarding result
      const sandboxStatus: SandboxStatus = result.__sandboxStatus ?? 'n/a'
      const isCliTool = registeredCliToolNames.has(toolCall.name)
      delete result.__sandboxStatus
      delete result.__resolvedTier
      delete result.__commandSummary
      delete result.__auditPromise

      // CLI tools write their own audit entry from executeCliTool (with
      // tool: 'cli:<name>' and resolved tier). Skip the generic loop-level
      // audit for them to avoid duplicate records. All other tools get
      // the standard entry here.
      if (!isCliTool) {
        appendAuditEntry({
          ts: new Date().toISOString(),
          kind: 'tool_call',
          sessionId: opts.toolContext.sessionId ?? 'unknown',
          platform: process.platform,
          tool: toolCall.name,
          tier,
          argsHash: argsHashValue,
          resultSize: result.content.length,
          durationMs: Date.now() - startedAt,
          mode: opts.toolContext.mode ?? 'ask',
          exitCode: result.isError ? 1 : 0,
          sandbox: sandboxStatus,
          // Phase 31 (SEC-13): Discord source attribution — only present when
          // toolContext carries source fields (set by Discord runner adapter).
          ...(opts.toolContext.source !== undefined && {
            source: opts.toolContext.source,
            discordUserId: opts.toolContext.discordUserId,
            discordChannelId: opts.toolContext.discordChannelId,
          }),
        }).catch(() => {})
      }

      // Phase 63 (OBS-01): tool_error emission — additive to tool_call, fires
      // on BOTH failure paths (throw → captured above; or {isError:true}
      // returned by the tool handler). Unconditionally emitted regardless of
      // CLI vs non-CLI so every tool failure surfaces in one place for the
      // OBS-02 rolling metric. Best-effort: audit write failures are swallowed
      // via .catch(()=>{}) so the agent loop never crashes on disk errors.
      if (result.isError) {
        let errorClass: string
        let errorMessage: string
        if (capturedErr !== null) {
          ;({ errorClass, errorMessage } = classifyError(capturedErr))
        } else {
          // Tool handler reported the failure by returning {isError:true}
          // without throwing. Use a stable errorClass so OBS-02 can group
          // these separately from throw-path errors, and carry the tool's
          // reported content as the message (truncated to 500 chars).
          errorClass = 'ToolReportedError'
          const rawMsg = result.content ?? ''
          errorMessage = rawMsg.length > 500 ? rawMsg.slice(0, 499) + '…' : rawMsg
        }
        const toolErrorEntry = {
          ts: new Date().toISOString(),
          kind: 'tool_error' as const,
          sessionId: opts.toolContext.sessionId ?? 'unknown',
          platform: process.platform,
          tool: toolCall.name,
          errorClass,
          errorMessage,
          ...(opts.turnId !== undefined && { turnId: opts.turnId }),
          ...(opts.toolContext.source !== undefined && {
            source: opts.toolContext.source,
            discordUserId: opts.toolContext.discordUserId,
            discordChannelId: opts.toolContext.discordChannelId,
            // Also populate generic channelId per Phase 63 CONTEXT schema
            // so OBS-02 can key by channelId across Discord + non-Discord.
            channelId: opts.toolContext.discordChannelId,
          }),
        }
        // Phase 63 (OBS-03): feed the in-memory ring buffer synchronously
        // so the tick watcher (60s cadence) sees every failure without
        // waiting for the audit JSONL to flush to disk. Best-effort — any
        // throw from the metric layer must not crash the agent loop.
        try {
          recordToolError(toolErrorEntry)
        } catch {
          // swallow — metric is best-effort, same discipline as audit
        }
        appendAuditEntry(toolErrorEntry).catch(() => {})
      }

      const truncated = truncateResult(result.content)
      opts.callbacks.onToolResult(toolCall.id, toolCall.name, truncated, result.isError)

      // PostToolUse hooks — after execute, before pushing tool message
      const postCmds = matchHooks('PostToolUse', toolCall.name, hooks)
      if (postCmds.length > 0) {
        try {
          const postResults = await runHooks('PostToolUse', toolCall.name, postCmds)
          const failed = postResults.filter((r) => r.exitCode !== 0 || r.timedOut)
          if (failed.length > 0) {
            opts.callbacks.onHookWarning?.('PostToolUse', toolCall.name, failed)
          }
        } catch {}
      }

      messages.push({
        role: 'tool',
        content: truncated,
        toolCallId: toolCall.id,
      })
    }
    iteration++
  }

  // Phase 22 (AGENT-01): natural termination (no more tool calls, or
  // maxIterations reached via the for-loop condition). Cap exits return
  // earlier and skip both this callback and Stop hooks.
  opts.onExit?.('natural')

  // Stop hooks — after the agent loop exits
  const stopCmds = matchHooks('Stop', '', hooks)
  if (stopCmds.length > 0) {
    try {
      const stopResults = await runHooks('Stop', '', stopCmds)
      const failed = stopResults.filter((r) => r.exitCode !== 0 || r.timedOut)
      if (failed.length > 0) {
        opts.callbacks.onHookWarning?.('Stop', '', failed)
      }
    } catch {}
  }
}
