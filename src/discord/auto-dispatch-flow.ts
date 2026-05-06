/**
 * Phase 60 (DISPATCH-01, 05, 06, 07): route a matched auto-dispatch message
 * to the orchestration engine.
 *
 * Extracted from runner.ts to keep runner.ts under the 800-line cap per
 * CLAUDE.md. This file owns the post-match flow (ack + cancellation window +
 * deep-clone + orchestration invocation + cooldown seed); runner.ts owns the
 * pre-enqueue gate (decrementCooldown + maybeAutoDispatch).
 *
 * Flow per D-05/D-06/D-08/D-10:
 *   1. Post one-shot ack message ("Routing to orchestrator — reply !cancel...")
 *   2. Open cancellation window via setPendingAutoDispatch (resolver + timer)
 *   3. If !cancel arrives within window → abort silently (return)
 *   4. Otherwise, deep-clone conversation history at dispatch time (D-08)
 *   5. Invoke runOrchestrateDiscord with parentContext
 *   6. In finally: registerOrchestrationComplete → cooldown=2 turns (D-10)
 */

import { log } from '../log/logger.js'
import {
  setPendingAutoDispatch,
  registerOrchestrationComplete,
} from './auto-dispatch-state.js'
import { runOrchestrateDiscord } from '../orchestration/discord.js'
import type { DiscordMessage, DiscordRunnerDeps } from './runner.js'

/**
 * channelId is the ORIGINATING channel (pre-thread) — auto-dispatch state is
 * keyed per-channel so user !cancel replies always route correctly regardless
 * of whether handleDiscordMessage later creates a thread for normal chat.
 */
export async function handleAutoDispatch(
  msg: DiscordMessage,
  deps: DiscordRunnerDeps,
  channelId: string,
): Promise<void> {
  // D-06: post one-shot ack. Verbatim text per plan acceptance criterion.
  try {
    await msg.reply('🚀 Routing to orchestrator — reply `!cancel` within 10s to abort.')
  } catch (err) {
    // Ack post failure is non-fatal — log and continue; dispatch still runs.
    log('error', {
      module: 'discord-runner',
      source: 'discord',
      discordChannelId: channelId,
      error: err instanceof Error ? err.message : String(err),
    }, 'auto-dispatch ack post failed')
  }

  // D-05: cancellation window. config.autoDispatch.cancellationWindowMs is
  // Zod-bounded [1000, 30000] with default 10000 (60-01). Tests inject a
  // short window (50-100ms) to keep the suite deterministic.
  const cancellationWindowMs =
    deps.config.discord?.autoDispatch?.cancellationWindowMs ?? 10_000

  const cancelled = await new Promise<boolean>((resolve) => {
    setPendingAutoDispatch(channelId, resolve, cancellationWindowMs)
  })

  if (cancelled) {
    // D-05: user sent !cancel before the window closed. Silent abort.
    log('info', {
      module: 'discord-runner',
      source: 'discord',
      discordChannelId: channelId,
    }, 'auto-dispatch cancelled by user')
    return
  }

  // D-08: deep-clone conversation history AT dispatch time (not before the
  // window opened, not later after orchestration started). Prevents
  // double-compression (ConversationManager's stripToolResults would otherwise
  // mutate the same array while workers read from it) and mid-run context
  // drift. structuredClone is V8-native, handles nested arrays/objects
  // correctly, and does not require a custom deep-clone implementation.
  const history = deps.conversations.getHistory(channelId)
  const parentContext = { messages: structuredClone(history) }

  // Build OrchestrateCommandDeps subset from DiscordRunnerDeps.
  // runOrchestrateDiscord accepts the same KristosConfig/provider/registry
  // plus optional sendDm/ownerId/conversations.
  const orchestrateDeps = {
    config: deps.config,
    provider: deps.provider,
    registry: deps.registry,
    sendDm: deps.sendDm,
    ownerId: deps.ownerId,
    conversations: deps.conversations,
  }

  try {
    await runOrchestrateDiscord(
      msg as any,
      // Minimal OrchestrationRunConfig — auto-dispatch bypasses the
      // decomposer and feeds the raw user message as a single task. Matches
      // the freeform path at a lower structural level.
      {
        schemaVersion: 1,
        maxWorkerTurns: 20,
        maxRetries: 2,
        escalationTimeoutMinutes: 30,
        tasks: [
          {
            id: `auto-dispatch-${Date.now()}`,
            prompt: msg.content,
            escalation: 'auto_accept' as const,
          },
        ],
      } as any,
      orchestrateDeps as any,
      deps.sendDm,
      deps.ownerId,
      parentContext,
    )
  } catch (err) {
    // runOrchestrateDiscord generally does not throw (internal try/catch),
    // but we are belt-and-suspenders about registerOrchestrationComplete
    // always firing regardless of orchestration outcome.
    log('error', {
      module: 'discord-runner',
      source: 'discord',
      discordChannelId: channelId,
      error: err instanceof Error ? err.message : String(err),
    }, 'auto-dispatched orchestration threw')
  } finally {
    // D-10: cooldown=2 after orchestration completes (success or failure) so
    // back-to-back auto-dispatches don't fire.
    registerOrchestrationComplete(channelId)
  }
}
