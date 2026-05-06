/**
 * Phase 71 (TGCMDS-01..07): Telegram slash command dispatcher.
 *
 * Mirrors src/discord/commands.ts handler structure, adapted for grammy
 * Context. All seven commands intercept BEFORE the agent loop; see
 * runner.ts handleTelegramMessage where isTelegramCommand is checked
 * before enqueue().
 *
 * Reply paths use ctx.reply (HTML mode is wired by Phase 70's
 * normalizeIncomingMessage — but this file uses ctx.reply directly for
 * orchestration-adapter compat; HTML escaping is the caller's
 * responsibility for any user-supplied substrings).
 */
import { homedir } from 'node:os'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'grammy'
import type { Provider } from '../providers/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import type { ConversationManager } from '../discord/conversation.js'
import type { LoadedContext } from '../context/loader.js'
import type { UsageRecord } from './usage-store.js'
import type { ToolErrorSample } from '../security/tool-error-metrics.js'
import { log } from '../log/logger.js'

// ── Public types ──────────────────────────────────────────────────────────────

export interface TelegramCommandDeps {
  config: KristosConfig
  provider: Provider
  registry: ToolRegistry
  conversations: ConversationManager
  model: string
  sharedContext?: LoadedContext
  sessionMapping: Record<string, string>
  // Test injectables — production callers omit these; defaults to real impls.
  writeFileSyncFn?: typeof writeFileSync
  readFileSyncFn?: typeof readFileSync
  existsSyncFn?: typeof existsSync
  spawnFn?: typeof Bun.spawn
  loadUsageRecordsFn?: (from: Date, to: Date) => Promise<UsageRecord[]>
  getRecentErrorsFn?: (windowMs: number, limit: number) => ToolErrorSample[]
  handleOrchestrateCommandFn?: typeof import('../orchestration/discord.js').handleOrchestrateCommand
}

// ── isTelegramCommand ─────────────────────────────────────────────────────────

/**
 * Returns true if the message content should be handled as a Telegram slash
 * command rather than forwarded to the agent loop.
 */
export function isTelegramCommand(content: string): boolean {
  const c = content.trim()
  if (c === '/cost' || c.startsWith('/cost ')) return true
  if (c === '/context' || c.startsWith('/context ')) return true
  if (c === '/compact' || c.startsWith('/compact ')) return true
  if (c === '/model' || c.startsWith('/model ')) return true
  if (c === '/clear' || c.startsWith('/clear ')) return true
  if (c === '/tool_errors' || c.startsWith('/tool_errors ')) return true
  if (c === '/orchestrate' || c.startsWith('/orchestrate ')) return true
  if (c.startsWith('!orchestrate ')) return true
  return false
}

// ── handleTelegramCommand — dispatcher ───────────────────────────────────────

/**
 * Route a recognized command to its handler. Callers must check
 * isTelegramCommand(content) before calling this.
 */
export async function handleTelegramCommand(
  ctx: Context,
  content: string,
  chatId: string,
  authorId: string,
  deps: TelegramCommandDeps,
): Promise<void> {
  const c = content.trim()

  if (c === '/cost' || c.startsWith('/cost ')) {
    await handleCost(ctx, deps)
    return
  }
  if (c === '/context' || c.startsWith('/context ')) {
    await handleContext(ctx, deps)
    return
  }
  if (c === '/compact' || c.startsWith('/compact ')) {
    await handleCompact(ctx, chatId, deps)
    return
  }
  if (c === '/model' || c.startsWith('/model ')) {
    await handleModel(ctx, c, deps)
    return
  }
  if (c === '/clear' || c.startsWith('/clear ')) {
    await handleClear(ctx, chatId, deps)
    return
  }
  if (c === '/tool_errors' || c.startsWith('/tool_errors ')) {
    await handleToolErrors(ctx, c, deps)
    return
  }
  if (c === '/orchestrate' || c.startsWith('/orchestrate ') || c.startsWith('!orchestrate ')) {
    await handleOrchestrate(ctx, c, chatId, authorId, deps)
    return
  }
}

// ── /cost (TGCMDS-01) ────────────────────────────────────────────────────────

async function handleCost(ctx: Context, deps: TelegramCommandDeps): Promise<void> {
  const loadFn = deps.loadUsageRecordsFn
    ?? (await import('./usage-store.js')).loadUsageRecords
  const { formatDiscordUsage } = await import('../discord/usage-format.js')

  const now = new Date()
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))
  const records = await loadFn(startOfDay, endOfDay)

  if (records.length === 0) {
    await ctx.reply('No usage recorded today.')
    return
  }

  const pricing = (deps.config as Record<string, unknown>)['telegram']
    ? ((deps.config as Record<string, unknown>)['telegram'] as Record<string, unknown>)['pricing'] as Record<string, { input: number; output: number }> | undefined
    : undefined
  const pricingFallback = (deps.config as Record<string, unknown>)['discord']
    ? ((deps.config as Record<string, unknown>)['discord'] as Record<string, unknown>)['pricing'] as Record<string, { input: number; output: number }> | undefined
    : undefined

  await ctx.reply(formatDiscordUsage(records, pricing ?? pricingFallback, deps.model))
}

// ── /context (TGCMDS-02) ─────────────────────────────────────────────────────

async function handleContext(ctx: Context, deps: TelegramCommandDeps): Promise<void> {
  const sc = deps.sharedContext
  if (!sc || sc.files.length === 0) {
    await ctx.reply('No context files loaded.')
    return
  }

  const lines: string[] = [
    `<b>Context files</b> (~${sc.totalEstimatedTokens} tokens total):`,
  ]
  for (const f of sc.files) {
    lines.push(`${f.label}  ~${f.estimatedTokens} tokens`)
  }

  await ctx.reply(lines.join('\n'))
}

// ── /compact (TGCMDS-03) ─────────────────────────────────────────────────────

async function handleCompact(ctx: Context, chatId: string, deps: TelegramCommandDeps): Promise<void> {
  const history = deps.conversations.getHistory(chatId)

  if (history.length === 0) {
    await ctx.reply('Nothing to compact.')
    return
  }

  const prompt = (
    'Summarise the conversation below in ≤200 words. Preserve facts and decisions.\n\n'
    + JSON.stringify(history)
  )

  // Provider interface only has stream() — there is no complete() method.
  const chunks: string[] = []
  const result = await deps.provider.stream(
    [{ role: 'user', content: prompt }],
    [],
    {
      onTextChunk: (chunk: string) => { chunks.push(chunk) },
      maxTokens: 1024,
    },
  )

  const summaryText = result.text || chunks.join('') || '(empty summary)'

  deps.conversations.clear(chatId)
  deps.conversations.addAssistantMessage(chatId, '[compacted summary]\n' + summaryText)

  await ctx.reply(
    `Conversation compacted (${history.length} message${history.length === 1 ? '' : 's'} → 1 summary).`,
  )
}

// ── /model (TGCMDS-04) ───────────────────────────────────────────────────────

const MODEL_PRESETS: Record<string, { provider: string; model: string; label: string }> = {
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  glm: { provider: 'openai-compat', model: 'glm-5.1', label: 'GLM-5.1' },
  deepseek: { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3' },
}

async function handleModel(ctx: Context, content: string, deps: TelegramCommandDeps): Promise<void> {
  const parts = content.split(/\s+/)
  const arg = parts[1]?.toLowerCase()
  const modelStatePath = join(homedir(), '.telemachus', 'telegram-model-state.json')

  const writeFn = deps.writeFileSyncFn ?? writeFileSync
  const readFn = deps.readFileSyncFn ?? readFileSync
  const existsFn = deps.existsSyncFn ?? existsSync
  const spawnFn = deps.spawnFn ?? Bun.spawn

  if (!arg || arg === 'status') {
    let current = 'default (profile default)'
    if (existsFn(modelStatePath)) {
      try {
        const state = JSON.parse(readFn(modelStatePath, 'utf-8') as string) as {
          model?: string
          provider?: string
        }
        if (state.model) current = `${state.model} via ${state.provider}`
      } catch {
        // ignore malformed telegram-model-state.json
      }
    }
    const opts = Object.entries(MODEL_PRESETS)
      .map(([k, v]) => `<code>/model ${k}</code> (${v.label})`)
      .join(', ')
    await ctx.reply(`Current model: <b>${current}</b>\nAvailable: ${opts}`, { parse_mode: 'HTML' })
    return
  }

  const preset = MODEL_PRESETS[arg]
  if (!preset) {
    const available = Object.keys(MODEL_PRESETS)
      .map((k) => `<code>${k}</code>`)
      .join(', ')
    await ctx.reply(`Unknown model <code>${arg}</code>. Available: ${available}`, { parse_mode: 'HTML' })
    return
  }

  writeFn(modelStatePath, JSON.stringify({ provider: preset.provider, model: preset.model }, null, 2))
  // TRAJ-02: manual model override = dissatisfaction signal
  void import('../shared/trajectory.js').then(({ appendSignal }) =>
    appendSignal({
      ts: new Date().toISOString(),
      transport: 'telegram',
      type: 'manual_override',
      model: preset.model,
    })
  )
  await ctx.reply(`Switching to <b>${preset.label}</b> — restarting now... 🔄`, { parse_mode: 'HTML' })

  const uid = process.getuid?.() ?? 501
  const launchArgs: [string[], Record<string, unknown>] = [
    ['launchctl', 'kickstart', '-k', `gui/${uid}/com.telemachus.telegram`],
    { stdout: 'ignore', stderr: 'ignore' },
  ]

  if (deps.spawnFn) {
    // Injected in tests — call immediately (no delay needed in test environment).
    spawnFn(...launchArgs)
    log('info', { module: 'telegram-commands', source: 'telegram', preset: arg }, '/model restart triggered')
  } else {
    // Production: delay restart to allow the reply to be delivered before the process dies.
    setTimeout(() => {
      spawnFn(...launchArgs)
      log('info', { module: 'telegram-commands', source: 'telegram', preset: arg }, '/model restart triggered')
    }, 1500)
  }
}

// ── /clear (TGCMDS-05) ───────────────────────────────────────────────────────

async function handleClear(ctx: Context, chatId: string, deps: TelegramCommandDeps): Promise<void> {
  deps.conversations.clear(chatId)
  await ctx.reply('Conversation cleared.')
}

// ── /orchestrate (TGCMDS-06) ─────────────────────────────────────────────────

async function handleOrchestrate(
  ctx: Context,
  content: string,
  chatId: string,
  authorId: string,
  deps: TelegramCommandDeps,
): Promise<void> {
  const orchestrateFn = deps.handleOrchestrateCommandFn
    ?? (await import('../orchestration/discord.js')).handleOrchestrateCommand

  // Adapt the grammy context to the DiscordMessage shape expected by handleOrchestrateCommand.
  const discordMsg = {
    channelId: chatId,
    content,
    authorId,
    reply: (text: string) => ctx.reply(text).then(() => undefined),
    sendTyping: () => ctx.replyWithChatAction('typing').then(() => undefined),
    isGuild: false,
    isThread: false,
    attachments: [],
    createThread: undefined,
    replyEditable: undefined,
  }

  await orchestrateFn(discordMsg, {
    config: deps.config,
    provider: deps.provider,
    registry: deps.registry,
    sendDm: undefined,
    ownerId: undefined,
    conversations: deps.conversations,
  })
}

// ── /tool_errors (TGCMDS-07) ─────────────────────────────────────────────────

const TOOL_ERROR_WINDOWS: Record<string, { ms: number; label: string }> = {
  '15m': { ms: 15 * 60_000, label: '15m' },
  '1h': { ms: 60 * 60_000, label: '1h' },
  '24h': { ms: 24 * 60 * 60_000, label: '24h' },
}

async function handleToolErrors(ctx: Context, content: string, deps: TelegramCommandDeps): Promise<void> {
  const getRecentErrorsFn = deps.getRecentErrorsFn
    ?? (await import('../security/tool-error-metrics.js')).getRecentErrors
  const { formatToolErrorSection } = await import('../discord/tool-error-format.js')

  const parts = content.trim().split(/\s+/)
  const raw = parts[1]

  if (raw !== undefined && raw !== '' && !TOOL_ERROR_WINDOWS[raw]) {
    const supported = Object.keys(TOOL_ERROR_WINDOWS).join(', ')
    await ctx.reply(`Unsupported window \`${raw}\` — supported: ${supported}.`)
    return
  }

  const window = raw ? TOOL_ERROR_WINDOWS[raw]! : TOOL_ERROR_WINDOWS['15m']!
  const samples = getRecentErrorsFn(window.ms, 100)
  const section = formatToolErrorSection(samples, window.label)
  await ctx.reply(section)
}
