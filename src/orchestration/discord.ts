/**
 * Phase 40-02 (ENTRY-02): Discord `!orchestrate` command handler.
 * Phase 40-03 (ENTRY-03): DM escalation wiring.
 * Phase 44-02: Extended with freeform NL orchestration and --cheap mode.
 * Phase 53-03: Extended with runWaveFailFastDiscordPrompt + resolveWaveFailFastReply.
 *
 * Provides `handleOrchestrateCommand` — invoked by the Discord command
 * dispatcher (src/discord/commands.ts) when a message matches `!orchestrate`.
 *
 * Flow (JSON path):
 *   1. Parse inline JSON from message content
 *   2. Validate with OrchestrationRunConfigSchema
 *   3. Reply immediately with confirmation
 *   4. Run orchestration in fire-and-forget mode with status hooks
 *   5. Post status updates for significant state transitions
 *   6. Post completion summary when done
 *
 * Flow (freeform NL path — Phase 44-02):
 *   1. Detect that content after "!orchestrate " is not valid JSON
 *   2. Call handleFreeformOrchestrateCommand
 *   3. Decompose NL via decompose()
 *   4. Show plan preview via msg.reply
 *   5. Wait for owner to reply "yes"/"approve" or "no"/"cancel" via DM
 *   6. If approved: run orchestration (with cheap overrides if --cheap)
 *   7. If rejected: reply "Plan cancelled." and return
 *
 * Significant transitions (posted to Discord):
 *   worker_running, reviewing, approved, rejected, escalated, failed
 *
 * Non-significant transitions (silent):
 *   review_pending, redirected, queued
 *
 * Phase 40-03 additions:
 *   - Wires createEscalationHandler into runOrchestrateDiscord when sendDm + ownerId present
 *   - Exports getActiveEscalationHandler for DM reply routing in bot.ts
 *
 * Phase 44-02 additions:
 *   - Detects JSON vs freeform in handleOrchestrateCommand
 *   - handleFreeformOrchestrateCommand for NL decompose + approval gate
 *   - --cheap flag strips to GLM model override for decomposer + all tasks
 *   - Exports resolvePendingPlanApproval for bot DM routing
 *
 * Phase 53-03 additions:
 *   - runWaveFailFastDiscordPrompt: pure IO-injectable 3-way prompt helper
 *   - _pendingWaveFailFast / resolveWaveFailFastReply: module-level resolver
 *     mirroring the _pendingPlanApproval pattern for bot.ts DM routing
 *   - runOrchestrateDiscord wires production prompt with 5-min timeout (abort)
 *   - bot.ts wiring of resolveWaveFailFastReply is OUT OF SCOPE (deferred)
 */

import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildAllTools } from '../tools/builtin/index.js'
import { maybeLoadIndexClient } from '../project-index/maybe-load.js'
import type { SubagentParent } from '../agent/subagent.js'
import type { Provider } from '../providers/types.js'
import type { KristosConfig } from '../config/types.js'
import type { DiscordMessage } from '../discord/runner.js'
import type { ConversationManager } from '../discord/conversation.js'
import { chunkMessage } from '../discord/chunker.js'
import { OrchestrationRunConfigSchema, type OrchestrationRunConfig } from './config-schema.js'
import { runOrchestration, type OrchestrationHooks } from './engine.js'
import type { OrchestrationState } from './types.js'
import { createEscalationHandler, type EscalationHandler } from './escalation.js'
import { getTemplate, instantiateTemplate, listTemplates } from './templates/index.js'
import { decompose } from './decomposer.js'
import { awaitPlanApproval } from './plan-approval.js'
import type { WaveFailFastPrompt, WaveSnapshot } from './wave-fail-fast.js'
import { formatErrorExcerpt } from './wave-fail-fast.js'

// ---------------------------------------------------------------------------
// Cheap mode GLM override constants
// ---------------------------------------------------------------------------

const GLM_PROVIDER = 'openai-compat' as const
const GLM_MODEL = 'glm-4.7-flash'
const GLM_MODEL_OVERRIDE = { provider: GLM_PROVIDER, model: GLM_MODEL }

// ---------------------------------------------------------------------------
// Apply cheap-mode overrides to all task models
// ---------------------------------------------------------------------------

/**
 * Returns a new config with all task provider/model fields overridden to GLM.
 * Uses immutable pattern — original config is not mutated.
 */
function applyCheapOverrides(config: OrchestrationRunConfig): OrchestrationRunConfig {
  return {
    ...config,
    tasks: config.tasks.map((task) => ({
      ...task,
      provider: GLM_PROVIDER,
      model: GLM_MODEL,
    })),
  }
}

// ---------------------------------------------------------------------------
// Module-level plan approval pending state
// ---------------------------------------------------------------------------

/**
 * Closure-scoped plan approval resolver — null when no plan approval is pending.
 * Set by handleFreeformOrchestrateCommand when awaiting Discord confirmation.
 * Resolved by resolvePendingPlanApproval (called from bot DM router).
 */
let _pendingPlanApproval: ((approved: boolean) => void) | null = null
let _pendingPlanApprovalTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Called by the bot's DM message handler when a DM arrives.
 * Resolves any pending plan approval based on the owner's reply.
 *
 * Returns true if the message was consumed; false otherwise.
 */
export function resolvePendingPlanApproval(content: string): boolean {
  if (_pendingPlanApproval === null) return false

  const normalized = content.toLowerCase().trim()
  const isApprove = normalized === 'yes' || normalized === 'approve' || normalized === 'y'
  const isReject = normalized === 'no' || normalized === 'cancel' || normalized === 'n' || normalized === 'reject'

  if (!isApprove && !isReject) return false

  if (_pendingPlanApprovalTimer !== null) {
    clearTimeout(_pendingPlanApprovalTimer)
    _pendingPlanApprovalTimer = null
  }

  const resolver = _pendingPlanApproval
  _pendingPlanApproval = null
  resolver(isApprove)
  return true
}

// ── Module-level active escalation handler ────────────────────────────────────

/**
 * Module-level reference to the currently active escalation handler.
 * Set before orchestration starts, cleared when it completes.
 * Accessed by bot.ts via getActiveEscalationHandler() for DM reply routing.
 */
let _activeEscalationHandler: EscalationHandler | null = null

/**
 * Returns the currently active escalation handler, or null if none.
 * Used by bot.ts to intercept DM replies during orchestration.
 */
export function getActiveEscalationHandler(): EscalationHandler | null {
  return _activeEscalationHandler
}

// ── Phase 53-03: Module-level wave fail-fast resolver ────────────────────────

/**
 * Pending wave fail-fast reply resolver — null when no fail-fast pause is active.
 * Set by the production waveFailFastPrompt inside runOrchestrateDiscord when
 * awaiting a channel reply. Resolved by resolveWaveFailFastReply (called from
 * bot.ts DM/channel router — wiring is deferred, out of scope for plan 03).
 */
let _pendingWaveFailFast: ((decision: 'continue' | 'abort' | 'inspect') => void) | null = null
let _pendingWaveFailFastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Called by the bot's DM/channel message handler when a message arrives
 * during a fail-fast pause. Maps the message content to the 3-way decision
 * and resolves the awaiting promise.
 *
 * Returns true if the message was consumed (bot should NOT route it further);
 * false otherwise (caller falls through to normal handling).
 *
 * Note: bot.ts wiring to call this function is OUT OF SCOPE for plan 03 —
 * it will be added as a one-line follow-up during dogfood validation.
 */
export function resolveWaveFailFastReply(content: string): boolean {
  if (_pendingWaveFailFast === null) return false
  const normalized = content.toLowerCase().trim()
  let decision: 'continue' | 'abort' | 'inspect' | null = null
  if (normalized === 'continue' || normalized === 'c') decision = 'continue'
  else if (normalized === 'abort' || normalized === 'a') decision = 'abort'
  else if (normalized === 'inspect' || normalized === 'i') decision = 'inspect'
  if (decision === null) return false

  // Clear timer and resolver atomically before calling the resolver to prevent
  // double-invocation in the inspect re-arm path.
  const resolver = _pendingWaveFailFast
  _pendingWaveFailFast = null
  if (_pendingWaveFailFastTimer !== null) {
    clearTimeout(_pendingWaveFailFastTimer)
    _pendingWaveFailFastTimer = null
  }
  resolver(decision)
  return true
}

/**
 * Phase 53: Discord-friendly 3-way prompt for the wave fail-fast gate.
 * Loops on 'inspect' (re-posts inspection text then re-prompts via awaitReply).
 * Returns the engine-facing 'continue' | 'abort' decision.
 *
 * Pure with respect to post/awaitReply for testability. Production wiring in
 * runOrchestrateDiscord composes this with module-level resolver + channel posts.
 */
export async function runWaveFailFastDiscordPrompt(
  snapshot: WaveSnapshot,
  io: {
    post: (text: string) => Promise<void>
    awaitReply: () => Promise<'continue' | 'abort' | 'inspect'>
  },
): Promise<'continue' | 'abort'> {
  const failedIds = snapshot.failedTasks.map((f) => f.id).join(', ')
  const summary =
    `:warning: Wave ${snapshot.waveNumber} fail-fast triggered: ` +
    `${snapshot.failedTasks.length}/${snapshot.totalTasks} failed ` +
    `(rate ${snapshot.rate.toFixed(2)} >= threshold ${snapshot.threshold}). ` +
    `Failed: ${failedIds}`

  while (true) {
    await io.post(summary)
    await io.post('Reply **continue** / **abort** / **inspect** (5 min timeout — defaults to abort).')
    const decision = await io.awaitReply()
    if (decision === 'continue') return 'continue'
    if (decision === 'abort') return 'abort'
    // inspect — post inspection text, loop and re-prompt
    await io.post(snapshot.formatInspection())
  }
}

// ── Phase 54 (CHAT-02): Canonical one-line orchestration summary ─────────────

/**
 * Phase 54 (CHAT-02): Build the canonical one-line summary that gets
 * appended to ConversationManager after an orchestration run completes.
 *
 * Format (verbatim per CONTEXT decision 2 / CHAT-02 success criterion):
 *   "Orchestration [runId] complete: X approved, Y failed. Failed: [task-a (reason), task-b (reason)]."
 *
 * Zero-task edge (CONTEXT decision 9):
 *   "Orchestration [runId] complete: no tasks executed."
 *
 * RunId truncated to first 8 chars when longer (CONTEXT decision 10,
 * consistent with how session IDs are displayed elsewhere).
 *
 * Approved count = finalState === 'approved' only.
 * Failed count + list = finalState === 'failed' only.
 * Other final states (escalated/rejected/canceled/queued) are
 * deliberately excluded from the summary to keep it terse and focused
 * on the two outcomes the chat agent needs to reason about.
 */
export function buildOrchestrationSummary(
  result: Pick<import('./engine.js').OrchestrationResult, 'runId' | 'taskResults'>,
): string {
  const shortId = result.runId.length > 8 ? result.runId.slice(0, 8) : result.runId
  if (result.taskResults.length === 0) {
    return `Orchestration [${shortId}] complete: no tasks executed.`
  }
  const approved = result.taskResults.filter((t) => t.finalState === 'approved').length
  const failedTasks = result.taskResults.filter((t) => t.finalState === 'failed')
  const failedList = failedTasks
    .map((t) => `${t.taskId} (${formatErrorExcerpt(t.error)})`)
    .join(', ')
  return `Orchestration [${shortId}] complete: ${approved} approved, ${failedTasks.length} failed. Failed: [${failedList}].`
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface OrchestrateCommandDeps {
  config: KristosConfig
  provider: Provider
  registry: ToolRegistry
  /**
   * Phase 40-03 (ENTRY-03): sendDm function from the Discord bot for
   * escalation DMs. Optional — when absent, escalation is not wired.
   */
  sendDm?: (userId: string, text: string) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): Discord user ID of the bot owner who receives
   * escalation DMs. Optional — when absent, escalation is not wired.
   */
  ownerId?: string
  /**
   * Phase 54 (CHAT-01..03): per-channel conversation history store.
   * When provided, orchestration completion/failure appends a structured
   * assistant turn so the chat agent on the next turn has factual awareness.
   */
  conversations?: ConversationManager
}

// ── Significant transitions ───────────────────────────────────────────────────

/**
 * States that merit a Discord message. These are the transitions where
 * something observable happens from the owner's perspective.
 * review_pending and redirected are internal — not posted.
 */
const SIGNIFICANT_STATES = new Set<OrchestrationState>([
  'worker_running',
  'reviewing',
  'approved',
  'rejected',
  'escalated',
  'failed',
])

/** Emoji prefix for each significant state */
const STATE_EMOJI: Partial<Record<OrchestrationState, string>> = {
  worker_running: ':gear:',
  reviewing: ':mag:',
  approved: ':white_check_mark:',
  rejected: ':x:',
  escalated: ':warning:',
  failed: ':x:',
}

// ── Public command handler ────────────────────────────────────────────────────

/**
 * Handle an `!orchestrate` Discord command.
 *
 * Detects whether the content after the prefix is JSON or freeform English.
 * - JSON: validates and runs immediately (original behavior)
 * - Freeform: decomposes via LLM and gates on plan approval
 * - --cheap flag: strips GLM model override for decomposer + all tasks
 */
export async function handleOrchestrateCommand(
  msg: DiscordMessage,
  deps: OrchestrateCommandDeps,
): Promise<void> {
  const rawContent = msg.content
  const prefix = '!orchestrate '
  let content = rawContent.startsWith(prefix)
    ? rawContent.slice(prefix.length).trim()
    : rawContent.slice('!orchestrate'.length).trim()

  // Process attachments: JSON files become config, text files become extra context
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      try {
        const res = await fetch(att.url)
        if (!res.ok) continue
        const text = await res.text()

        if (att.name.endsWith('.json')) {
          // JSON file attachment → use as config (replaces inline content)
          content = text
        } else {
          // Other text files → append as context for freeform decomposition
          content += `\n\n--- ${att.name} ---\n${text}`
        }
      } catch {
        // Failed to download — skip silently
      }
    }
  }

  // Detect and strip --cheap flag
  const cheapFlag = content.includes('--cheap')
  if (cheapFlag) {
    content = content.replace(/--cheap\s*/g, '').trim()
  }

  // Try JSON parse — if it succeeds, use JSON config path
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    // Not valid JSON — treat as freeform NL prompt
    if (!content) {
      await msg.reply(
        'Usage: `!orchestrate <json-config>` or `!orchestrate <english prompt>`\nYou can also attach a .json config file.',
      )
      return
    }
    await handleFreeformOrchestrateCommand(msg, content, cheapFlag, deps)
    return
  }

  // JSON path: validate with schema
  const parsed = OrchestrationRunConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const errorMsg = parsed.error.message
    const truncated = errorMsg.length > 1500 ? errorMsg.slice(0, 1500) + '...' : errorMsg
    await msg.reply(`Config error: ${truncated}`)
    return
  }

  const config = parsed.data
  const taskCount = config.tasks.length
  const plural = taskCount === 1 ? '' : 's'

  // Reply immediately
  await msg.reply(`Orchestration started (${taskCount} task${plural}). Status updates follow...`)

  // Fire-and-forget orchestration run
  void runOrchestrateDiscord(msg, config, deps, deps.sendDm, deps.ownerId)
}

// ── Freeform NL orchestration ─────────────────────────────────────────────────

/**
 * Handle a freeform NL `!orchestrate <english>` command.
 *
 * Decomposes the prompt via LLM, shows plan preview, waits for owner approval
 * via DM, then runs orchestration if approved.
 *
 * Discord approval flow:
 *   1. Reply with "Decomposing..." status
 *   2. Call decompose() with the prompt
 *   3. Reply with formatted plan preview
 *   4. Set up pending plan approval (resolved by resolvePendingPlanApproval)
 *   5. Wait up to 5 minutes for the owner to reply "yes"/"no"
 *   6. If approved: run orchestration (with cheap overrides if applicable)
 *   7. If rejected/timeout: reply "Plan cancelled." and return
 */
export async function handleFreeformOrchestrateCommand(
  msg: DiscordMessage,
  prompt: string,
  cheap: boolean,
  deps: OrchestrateCommandDeps,
): Promise<void> {
  await msg.reply('Decomposing your request...')

  // Build SubagentParent from deps
  const kcConfig = await loadConfig(process.cwd())
  const provider = createProvider(kcConfig)
  // v3.1 Phase 51: pass optional IndexClient for index-aware glob/grep.
  const loadedIndex = await maybeLoadIndexClient()
  const registry = new ToolRegistry()
  registry.registerAll(buildAllTools(kcConfig, loadedIndex?.client ?? null))

  const parent: SubagentParent = {
    provider,
    registry,
    apiSchemas: registry.toAPISchema(),
    toolContext: {
      cwd: process.cwd(),
      toolTimeoutMs: kcConfig.toolTimeoutMs,
      askUser: async () => '',
      checkPermission: async () => 'allow',
      sessionId: `orchestrate-discord-freeform-${Date.now()}`,
      mode: 'agent',
      originalCwd: process.cwd(),
      source: 'discord',
      discordChannelId: msg.channelId,
    },
    temperature: kcConfig.temperature,
    windowSize: kcConfig.windowSize,
    maxIterations: 20,
  }

  let decomposeResult: Awaited<ReturnType<typeof decompose>>
  try {
    decomposeResult = await decompose({
      parent,
      prompt,
      modelOverride: cheap ? GLM_MODEL_OVERRIDE : undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await msg.reply(`Decomposition failed: ${message}`)
    return
  }

  // Display plan preview using awaitPlanApproval
  // Discord confirmFn: wait for owner to reply "yes"/"no" via DM or channel
  const PLAN_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

  const displayFn = async (text: string): Promise<void> => {
    const chunks = chunkMessage(text)
    for (const chunk of chunks) {
      await msg.reply(chunk)
    }
    await msg.reply('Reply **yes** to approve or **no** to cancel (5 minute timeout).')
  }

  const confirmFn = async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      _pendingPlanApproval = resolve

      // Auto-reject on timeout
      _pendingPlanApprovalTimer = setTimeout(() => {
        if (_pendingPlanApproval !== null) {
          _pendingPlanApproval = null
          _pendingPlanApprovalTimer = null
          resolve(false)
        }
      }, PLAN_APPROVAL_TIMEOUT_MS)
    })
  }

  const approvalResult = await awaitPlanApproval(decomposeResult, { displayFn, confirmFn })

  if (approvalResult === 'rejected') {
    await msg.reply('Plan cancelled.')
    return
  }

  // Apply cheap overrides if --cheap flag was used
  const finalConfig = cheap
    ? applyCheapOverrides(decomposeResult.config)
    : decomposeResult.config

  await msg.reply('Executing plan...')
  void runOrchestrateDiscord(msg, finalConfig, deps, deps.sendDm, deps.ownerId)
}

// ── Template command handlers ─────────────────────────────────────────────────

/**
 * Handle an `!orchestrate-templates` Discord command.
 *
 * Replies with a numbered list of all available template names and descriptions.
 */
export async function handleListTemplatesCommand(msg: DiscordMessage): Promise<void> {
  const templates = listTemplates()
  if (templates.length === 0) {
    await msg.reply('No templates available.')
    return
  }

  const lines = templates.map((t, i) => `${i + 1}. **${t.name}** — ${t.description}`)
  await msg.reply(`Available project templates:\n${lines.join('\n')}`)
}

/**
 * Handle an `!orchestrate-template <name>` Discord command.
 *
 * Looks up the template, instantiates it, replies with confirmation, then
 * fire-and-forgets the orchestration run with the same hooks as !orchestrate.
 */
export async function handleOrchestrateTemplateCommand(
  msg: DiscordMessage,
  deps: OrchestrateCommandDeps,
): Promise<void> {
  const prefix = '!orchestrate-template '
  const templateName = msg.content.startsWith(prefix)
    ? msg.content.slice(prefix.length).trim()
    : msg.content.slice('!orchestrate-template'.length).trim()

  if (!templateName) {
    const templates = listTemplates()
    const list = templates.map((t) => `\`${t.name}\``).join(', ')
    await msg.reply(`Usage: \`!orchestrate-template <name>\`\nAvailable templates: ${list}`)
    return
  }

  const def = getTemplate(templateName)
  if (!def) {
    const available = listTemplates()
    const list = available.map((t) => `\`${t.name}\``).join(', ')
    await msg.reply(`Unknown template \`${templateName}\`. Available: ${list}`)
    return
  }

  let config: OrchestrationRunConfig
  try {
    config = await instantiateTemplate(def)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await msg.reply(`Template error: ${message}`)
    return
  }

  const taskCount = config.tasks.length
  const plural = taskCount === 1 ? '' : 's'
  await msg.reply(`Starting template run: **${def.name}** (${taskCount} task${plural}). Status updates follow...`)

  // Fire-and-forget orchestration run reusing the Discord runner
  void runOrchestrateDiscord(msg, config, deps, deps.sendDm, deps.ownerId)
}

// ── Internal runner ───────────────────────────────────────────────────────────

export async function runOrchestrateDiscord(
  msg: DiscordMessage,
  config: ReturnType<typeof OrchestrationRunConfigSchema.parse>,
  deps: OrchestrateCommandDeps,
  sendDm?: (userId: string, text: string) => Promise<void>,
  ownerId?: string,
  // Phase 60 (DISPATCH-07): optional preloaded conversation history. When set,
  // flows directly into SubagentParent.initialContext so orchestration workers
  // see the snapshot taken at dispatch time (D-08) rather than reading live
  // ConversationManager. Existing 3 callsites (handleOrchestrateCommand JSON,
  // handleFreeformOrchestrateCommand, handleOrchestrateTemplateCommand) pass 5
  // args — optional param defaults to undefined, preserving behavior.
  parentContext?: { messages: import('../providers/types.js').Message[] },
): Promise<void> {
  // Build SubagentParent — mirrors discord/index.ts pattern
  const kcConfig = await loadConfig(process.cwd())
  const provider = createProvider(kcConfig)
  // v3.1 Phase 51: pass optional IndexClient for index-aware glob/grep.
  const loadedIndex = await maybeLoadIndexClient()
  const registry = new ToolRegistry()
  registry.registerAll(buildAllTools(kcConfig, loadedIndex?.client ?? null))

  const parent: SubagentParent = {
    provider,
    registry,
    apiSchemas: registry.toAPISchema(),
    toolContext: {
      cwd: process.cwd(),
      toolTimeoutMs: kcConfig.toolTimeoutMs,
      askUser: async () => '',
      checkPermission: async () => 'allow',
      sessionId: `orchestrate-discord-${Date.now()}`,
      mode: 'agent',
      originalCwd: process.cwd(),
      source: 'discord',
      discordChannelId: msg.channelId,
    },
    temperature: kcConfig.temperature,
    windowSize: kcConfig.windowSize,
    maxIterations: 20,
    // Phase 60 (DISPATCH-07): when auto-dispatched, parentContext carries the
    // deep-cloned conversation snapshot from runner.ts. Reference-preserved
    // through this plumbing (caller did the structuredClone — we do not clone
    // again here per D-08 / acceptance criterion "no double-clone").
    initialContext: parentContext?.messages,
  }

  // Helper: post a message to the channel, chunking if needed
  const postChunked = async (text: string): Promise<void> => {
    const chunks = chunkMessage(text)
    for (const chunk of chunks) {
      await msg.reply(chunk)
    }
  }

  // Phase 40-03: Create escalation handler when sendDm + ownerId are available
  let escalation: EscalationHandler | null = null
  if (sendDm && ownerId) {
    escalation = createEscalationHandler(sendDm, ownerId)
    _activeEscalationHandler = escalation
  }

  // Step 5: Build hooks for status updates
  const hooks: OrchestrationHooks = {
    onTaskTransition: (
      taskId: string,
      _from: OrchestrationState,
      to: OrchestrationState,
    ) => {
      // Only post significant transitions
      if (!SIGNIFICANT_STATES.has(to)) return

      const emoji = STATE_EMOJI[to] ?? ''
      const statusLine = `${emoji} [${taskId}] ${to}`
      // Non-blocking — status updates are best-effort
      void postChunked(statusLine)
    },
    // Phase 40-03: Wire DM escalation gate when handler is available
    ...(escalation ? { onEscalated: escalation.onEscalated } : {}),
  }

  // Phase 53-03: Wire wave fail-fast prompt with 5-minute timeout (defaults to 'abort').
  // CONTEXT decision 7 implication: continuing through unattended failures is unsafe;
  // 'abort' is the safer default when the user does not respond in time.
  const WAVE_FAIL_FAST_TIMEOUT_MS = 5 * 60 * 1000
  const discordWaveFailFastPrompt: WaveFailFastPrompt = (snapshot) =>
    runWaveFailFastDiscordPrompt(snapshot, {
      post: postChunked,
      awaitReply: () =>
        new Promise<'continue' | 'abort' | 'inspect'>((resolve) => {
          _pendingWaveFailFast = resolve
          _pendingWaveFailFastTimer = setTimeout(() => {
            if (_pendingWaveFailFast !== null) {
              _pendingWaveFailFast = null
              _pendingWaveFailFastTimer = null
              resolve('abort')
            }
          }, WAVE_FAIL_FAST_TIMEOUT_MS)
        }),
    })

  const finalConfig: typeof config = { ...config, waveFailFastPrompt: discordWaveFailFastPrompt }

  try {
    const result = await runOrchestration(finalConfig, parent, undefined, hooks)

    // Step 6: Post completion summary
    const approved = result.taskResults.filter((t) => t.finalState === 'approved').length
    const failed = result.taskResults.filter((t) => t.finalState === 'failed').length
    const escalated = result.taskResults.filter((t) => t.finalState === 'escalated').length
    const rejected = result.taskResults.filter((t) => t.finalState === 'rejected').length

    const parts = [`Orchestration complete: ${approved} approved`]
    if (failed > 0) parts.push(`${failed} failed`)
    if (escalated > 0) parts.push(`${escalated} escalated`)
    if (rejected > 0) parts.push(`${rejected} rejected`)

    await postChunked(parts.join(', '))

    // Phase 54 (CHAT-01..03): Append structured summary to the channel's
    // ConversationManager as an assistant turn. This propagates to the chat
    // agent's initialMessages on the next turn via priorHistory (runner.ts
    // line 360), so a user asking "what failed?" gets a factual answer
    // sourced from history — no system-prompt surgery required.
    //
    // Silent no-op when conversations is not wired (e.g., legacy tests or
    // contexts without a channel-scoped history store). Best-effort: any
    // throw here must not shadow the orchestration result.
    if (deps.conversations) {
      try {
        deps.conversations.addAssistantMessage(
          msg.channelId,
          buildOrchestrationSummary(result),
        )
      } catch (err) {
        process.stderr.write(
          `[orchestration:discord] failed to append conversation summary: ${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await msg.reply(`Orchestration failed: ${message}`)
    } catch {
      process.stderr.write(`[orchestration:discord] failed to post error: ${message}\n`)
    }

    // Phase 54 (CHAT-01): Catastrophic failure path — chat agent must
    // see the crash, not silence. runId is unavailable here (runOrchestration
    // threw before returning a result, so OrchestrationResult.runId is
    // inaccessible). Use a timestamp-based id consistent with the
    // "orchestrate-discord-${Date.now()}" sessionId pattern already used in
    // parent.toolContext.sessionId above.
    if (deps.conversations) {
      try {
        const crashRunId = `err-${Date.now()}`
        const shortId = crashRunId.length > 8 ? crashRunId.slice(0, 8) : crashRunId
        // Keep under ~500 chars per CONTEXT decision 6.
        const truncatedMessage = message.length > 480 ? message.slice(0, 480) + '…' : message
        deps.conversations.addAssistantMessage(
          msg.channelId,
          `Orchestration [${shortId}] failed: ${truncatedMessage}`,
        )
      } catch (inner) {
        process.stderr.write(
          `[orchestration:discord] failed to append crash summary: ${inner instanceof Error ? inner.message : String(inner)}\n`,
        )
      }
    }
  } finally {
    // Phase 40-03: Clear active escalation handler when orchestration ends
    if (_activeEscalationHandler === escalation) {
      _activeEscalationHandler = null
    }
    // Phase 53-03: Defensive cleanup — clear any lingering wave fail-fast pending state
    if (_pendingWaveFailFast !== null) {
      _pendingWaveFailFast = null
    }
    if (_pendingWaveFailFastTimer !== null) {
      clearTimeout(_pendingWaveFailFastTimer)
      _pendingWaveFailFastTimer = null
    }
  }
}
