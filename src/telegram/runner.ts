/**
 * Phase 70 (TGAGENT-01..04): Telegram ↔ agent-loop adapter.
 *
 * handleTelegramMessage is the single entry point that:
 *   - Calls initSandboxEnv() on every message (idempotent)
 *   - Normalizes the grammy Context via normalizeIncomingMessage
 *   - Enqueues the turn onto the per-chat promise queue
 *   - Constructs the streaming reply writer (1500ms edit polling)
 *   - Runs the body inside wrapTurnExecution (catch + finally)
 */
import { randomUUID } from 'node:crypto'
import type { Context } from 'grammy'
import type { Provider } from '../providers/types.js'
import { resolveModelPricing } from '../usage/pricing.js'
import * as sandboxEnvModule from '../discord/sandbox-env.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import type { ConversationManager } from '../discord/conversation.js'
import type { RunJobMcpManager } from '../agent-runner/run-job.js'
import type { LoadedContext } from '../context/loader.js'
import { log } from '../log/logger.js'
import { normalizeIncomingMessage } from './message-intake.js'
import { enqueue } from './turn-queue.js'
import { createTelegramReplyWriter } from './reply-writer.js'
import { wrapTurnExecution } from './error-boundary.js'
import { runTurnBody, type TurnAgg, type TurnRouterSession } from './turn-execution.js'
import { isTelegramCommand, handleTelegramCommand, type TelegramCommandDeps } from './commands.js'

export interface TelegramRunnerDeps {
  config: KristosConfig
  provider: Provider
  registry: ToolRegistry
  conversations: ConversationManager
  /** Per-chat system prompt builder (Phase 71 wires persona). */
  systemPrompt?: (chatId: string) => string
  /** Live reference to chatId → sessionId mapping (mutated by ensureSession). */
  sessionMapping: Record<string, string>
  /** Model name for session metadata. */
  model: string
  /** Optional MCP manager for tool execution. */
  mcpManager?: RunJobMcpManager
  /**
   * Phase 70: tokenBudget left optional/undefined for v3.9.
   * Phase 71+ may add a TelegramTokenBudget; runTurnBody guards on its presence.
   */
  tokenBudget?: undefined
  /** Phase 71 (TGCMDS-02): captured loadSharedContext result for /context handler. */
  sharedContext?: LoadedContext
}

/**
 * Pure helper exported for tests. Mirrors discord/runner.ts computeIterationCost.
 */
export function computeIterationCost(
  usage: { inputTokens: number; outputTokens: number },
  model: string,
  telegramConfig?: { pricing?: Record<string, { input: number; output: number }> },
): number {
  const pricing = resolveModelPricing(model, telegramConfig as never)
  if (!pricing) return 0
  return (usage.inputTokens / 1_000_000) * pricing.inputPerMToken
    + (usage.outputTokens / 1_000_000) * pricing.outputPerMToken
}

export function handleTelegramMessage(deps: TelegramRunnerDeps) {
  return async (ctx: Context): Promise<void> => {
    sandboxEnvModule.initSandboxEnv()

    const intake = normalizeIncomingMessage(ctx)
    const { chatId, content, authorId } = intake

    // Skip empty messages — grammy emits message:text only when text exists,
    // but defensive guard keeps the queue clean.
    if (!content) return

    // Phase 71 (TGCMDS-01..07): command interception runs synchronously
    // (not enqueued) so commands return promptly without queueing behind
    // long-running agent turns. Commands cannot mutate conversation state
    // in ways that race with an in-flight turn for the same chatId, so
    // the per-chat ordering guarantee is preserved.
    if (isTelegramCommand(content)) {
      const cmdDeps: TelegramCommandDeps = {
        config: deps.config,
        provider: deps.provider,
        registry: deps.registry,
        conversations: deps.conversations,
        model: deps.model,
        sessionMapping: deps.sessionMapping,
        ...(deps.sharedContext !== undefined && { sharedContext: deps.sharedContext }),
      }
      try {
        await handleTelegramCommand(ctx, content, chatId, authorId, cmdDeps)
      } catch (err) {
        log('error', {
          module: 'telegram-runner',
          source: 'telegram',
          chatId,
          error: err instanceof Error ? err.message : String(err),
        }, 'command handler crashed')
        try { await ctx.reply('Command failed — check logs.') } catch { /* swallow */ }
      }
      return
    }

    // Phase 71: command interception above; non-commands fall through to enqueue.
    enqueue(chatId, async () => {
      const turnId = randomUUID()
      const routerSession: TurnRouterSession = {}
      const agg: TurnAgg = {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
      let contextSizeTokens: number | undefined = undefined

      const writer = createTelegramReplyWriter({
        chatId,
        sendMessage: intake.sendMessage,
        replySend: intake.replySend,
        replySendTyping: intake.replySendTyping,
        editMessage: intake.editMessage,
        userId: authorId,
      })
      await writer.start()

      await wrapTurnExecution(
        {
          writer,
          turnId,
          agg,
          routerSession,
          channelId: chatId,
          userId: authorId,
          defaultModel: deps.model,
          transport: 'telegram',
          getContextSizeTokens: () => contextSizeTokens,
        },
        () => runTurnBody({
          deps,
          msg: intake,
          writer,
          targetChatId: chatId,
          turnId,
          routerSession,
          agg,
          content,
          setContextSize: (tokens) => { contextSizeTokens = tokens },
        }),
      )
    })
  }
}
