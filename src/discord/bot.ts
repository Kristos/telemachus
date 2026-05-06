/**
 * Phase 31: Discord gateway bot — security gates + agent loop integration.
 * Connects to Discord, enforces owner allowlist, delegates messages to the
 * injected onMessage handler (constructed in index.ts with full provider stack).
 *
 * Phase 34 (OPS-03): Message cache bounded via Options.cacheWithLimits +
 * sweepers to prevent unbounded memory growth over 24+ hours.
 *
 * Phase 35 (TOKEN-05): onReady callback starts daily DM scheduler once the
 * client is connected and can send DMs.
 */
import { Client, GatewayIntentBits, Events, Options, Partials, ChannelType } from 'discord.js'
import type { KristosConfig } from '../config/types.js'
import type { DiscordConfig } from './config.js'
import type { DiscordMessage } from './runner.js'
import { setDraining, hasPendingTurns, drainAllTurns } from './runner.js'
import { log } from '../log/logger.js'

export interface BotOptions {
  config: KristosConfig
  discordConfig: DiscordConfig
  /** Handler for authorized messages — injected by index.ts after constructing provider/registry */
  onMessage: (msg: DiscordMessage) => Promise<void>
  /**
   * OPS-03: Maximum number of messages to cache per channel.
   * Defaults to 200. Bounded to prevent memory growth over long uptimes.
   */
  messageCacheMaxSize?: number
  /**
   * Phase 35 (TOKEN-05): Callback to start the daily DM scheduler once
   * the client is ready and can send DMs. Receives a sendDm function
   * bound to the live Client. Returns a stop function for cleanup.
   */
  onReady?: (sendDm: (userId: string, text: string) => Promise<void>) => { stop: () => void }
  /**
   * UPDATE-06: Called after gateway ready with sendDm function. Used for startup DM.
   * Fire-and-forget — startup DM must not block bot operation.
   */
  onStartup?: (sendDm: (userId: string, text: string) => Promise<void>) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): Returns the currently active escalation handler,
   * or null/undefined when no orchestration is running. Used to intercept
   * DM replies (approve/reject) before the agent loop sees them.
   *
   * A getter function rather than a static value so the bot always picks up
   * the current run's handler without requiring re-registration.
   */
  getEscalationHandler?: () => { hasPending: () => boolean; receiveDmReply: (content: string) => boolean } | null | undefined
}

export async function startDiscordBot(opts: BotOptions): Promise<void> {
  const { discordConfig } = opts

  // SEC-12: Read token from environment variable — never from config file
  const token = process.env[discordConfig.tokenEnv]
  if (!token) {
    throw new Error(
      `Discord bot token not found. Set the ${discordConfig.tokenEnv} environment variable.`
    )
  }

  // OPS-03: Cap message cache to prevent unbounded memory growth over 24+ hours.
  // Options.cacheWithLimits is the recommended discord.js v14 pattern.
  // The sweeper removes messages older than 10 minutes every 5 minutes.
  const messageCacheMaxSize = opts.messageCacheMaxSize ?? 200

  // SEC-10: Intents required for message content access
  // Partials.Channel is REQUIRED for DMs — without it, messageCreate never fires for DM channels
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: messageCacheMaxSize,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: {
        interval: 300,   // sweep every 5 minutes
        lifetime: 600,   // remove messages older than 10 minutes
      },
    },
  })

  // Build allowlist Set for O(1) lookup (SEC-11 / D-05)
  const allowedUsers = new Set(discordConfig.allowedUsers)

  // Phase 35 (TOKEN-05): scheduler stop function, set in ClientReady, called in shutdown
  let schedulerStop: (() => void) | null = null

  client.on(Events.ClientReady, (c) => {
    log('info', { module: 'discord-bot', source: 'discord', tag: c.user.tag }, 'Discord connected')

    const sendDm = async (userId: string, text: string) => {
      try {
        const user = await c.users.fetch(userId)
        await user.send(text)
      } catch (err) {
        log('error', { module: 'discord-bot', source: 'discord', userId, error: err instanceof Error ? err.message : String(err) }, 'failed to DM user')
      }
    }

    // TOKEN-05: Start daily DM scheduler now that the client can send DMs
    if (opts.onReady) {
      const scheduler = opts.onReady(sendDm)
      schedulerStop = scheduler.stop
    }

    // UPDATE-06: Send startup notification DM — fire and forget
    if (opts.onStartup) {
      void opts.onStartup(sendDm).catch((err) => {
        log('error', { module: 'discord-bot', source: 'discord', error: err instanceof Error ? err.message : String(err) }, 'startup DM failed')
      })
    }
  })

  // SEC-11 / D-07: messageCreate handler — bot check first, then allowlist
  client.on(Events.MessageCreate, async (message) => {
    // D-07: bot messages ignored first (prevents self-reply loops)
    if (message.author.bot) return

    // Debug: log all incoming non-bot messages (helps diagnose allowlist/intent issues)
    log('debug', {
      module: 'discord-bot',
      source: 'discord',
      userId: message.author.id,
      tag: message.author.tag,
      channelId: message.channelId,
      preview: message.content.slice(0, 50),
    }, 'incoming Discord message')

    // D-06: non-owner messages silently ignored — bot appears offline
    if (!allowedUsers.has(message.author.id)) return

    // Phase 31: route to agent loop via injected handler
    // Partial DM channels may not have full type info — fetch if needed
    const channel = message.channel
    if (channel.partial) {
      try { await channel.fetch() } catch { /* best effort */ }
    }

    const isDM = channel.type === ChannelType.DM
    const isThread = channel.type === ChannelType.PublicThread ||
                     channel.type === ChannelType.PrivateThread
    const isGuildChannel = !isDM && !isThread

    // Routing rules:
    // - DMs: always respond (no @mention needed)
    // - Existing threads: always respond (you're in a conversation)
    // - Guild channels: !commands work without @mention; chat requires @mention (creates a thread)
    if (isGuildChannel && !message.mentions.has(client.user!)) {
      if (!message.content.trim().startsWith('!')) {
        return  // guild channel message without @mention — ignore
      }
      // !commands bypass @mention requirement — reply in-channel, no thread created
    }

    // Strip the @mention from content so the agent sees clean text
    const cleanContent = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '')
      .trim()

    if (!cleanContent && message.attachments.size === 0) return  // empty after stripping @mention, no attachments

    // For DMs, use channel.send() instead of message.reply() to avoid
    // "not sent in a guild text channel" errors with partial channels
    const sendFn = isDM
      ? async (text: string) => { await channel.send(text) }
      : async (text: string) => { await message.reply(text) }

    // Extract attachments from the discord.js message
    const attachments = message.attachments.size > 0
      ? [...message.attachments.values()].map(a => ({
          url: a.url,
          name: a.name,
          contentType: a.contentType,
          size: a.size,
        }))
      : undefined

    const discordMsg: DiscordMessage = {
      channelId: message.channelId,
      content: cleanContent || (attachments ? '(see attachment)' : ''),
      authorId: message.author.id,
      attachments,
      reply: sendFn,
      sendTyping: async () => { await channel.sendTyping() },
      isGuild: isGuildChannel,
      isThread,
      ...(isGuildChannel ? {
        createThread: async (name: string) => {
          const thread = await message.startThread({ name, autoArchiveDuration: 60 })
          return {
            id: thread.id,
            send: async (text: string) => { await thread.send(text) },
            sendTyping: async () => { await thread.sendTyping() },
          }
        },
      } : {}),
    }

    // Intercept DM replies for pending plan approvals (Phase 44 decomposer flow).
    // Must happen BEFORE escalation check and onMessage.
    if (isDM) {
      const { resolvePendingPlanApproval } = await import('../orchestration/discord.js')
      if (resolvePendingPlanApproval(cleanContent)) return  // consumed by plan approval
    }

    // Phase 53: Intercept replies during a wave fail-fast pause.
    // Works in DMs, guild-channel threads, and @mentions alike — the pending
    // resolver is module-level and tied to the active orchestration run, not
    // to a specific channel type.
    {
      const { resolveWaveFailFastReply } = await import('../orchestration/discord.js')
      if (resolveWaveFailFastReply(cleanContent)) return  // consumed by wave fail-fast
    }

    // Phase 60 (DISPATCH-05): Intercept `!cancel` replies during an active
    // auto-dispatch cancellation window. Inserted at step 2.5 per 60-RESEARCH
    // Q1: after waveFailFast (long-lived 5-min gate wins) and before deploy
    // (so `!cancel` never leaks through to other resolvers).
    {
      const { tryResolveAutoDispatchCancel } = await import('./auto-dispatch-state.js')
      if (tryResolveAutoDispatchCancel(message.channelId, cleanContent)) return  // consumed by auto-dispatch cancel
    }

    // Intercept replies during a !deploy approval prompt. Same module-level
    // resolver pattern — any yes/no/approve/reject reply consumes the prompt
    // instead of falling through to the agent loop.
    {
      const { resolveDeployReply } = await import('./deploy-command.js')
      if (resolveDeployReply(cleanContent)) return  // consumed by deploy approval
    }

    // Phase 40-03 (ENTRY-03): Intercept DM replies for active orchestration escalations.
    // Must happen BEFORE opts.onMessage so approve/reject DMs never reach the agent loop.
    if (isDM && opts.getEscalationHandler) {
      const escalationHandler = opts.getEscalationHandler()
      if (escalationHandler?.hasPending()) {
        const consumed = escalationHandler.receiveDmReply(cleanContent)
        if (consumed) return  // DM was an escalation reply — do not pass to agent loop
        // Unrecognized reply during active escalation — send a hint
        void channel.send('Unrecognized reply. Use `approve` or `reject`.').catch((err: unknown) => {
          log('error', {
            module: 'discord-bot',
            source: 'discord',
            error: err instanceof Error ? err.message : String(err),
          }, 'failed to send escalation hint')
        })
        return
      }
    }

    // Fire and forget — the per-channel queue in runner.ts handles serialization.
    // Errors are caught inside handleDiscordMessage.
    opts.onMessage(discordMsg).catch((err) => {
      log('error', {
        module: 'discord-bot',
        source: 'discord',
        error: err instanceof Error ? err.message : String(err),
      }, 'unhandled Discord message error')
    })
  })

  // Connect to gateway
  await client.login(token)

  // Keep process alive — client.login() starts the WebSocket but the
  // Node/Bun event loop needs something to hold it open. The discord.js
  // Client keeps its own internal references, so this is just belt-and-suspenders.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      log('info', { module: 'discord-bot', source: 'discord' }, 'Discord shutting down — draining in-flight turns')
      // TOKEN-05: Stop daily DM scheduler before draining
      schedulerStop?.()
      // UPDATE-07: Stop accepting new messages immediately
      setDraining(true)
      // Phase 60 (Q3): Clear auto-dispatch timers + resolvers before draining
      // channels. Each pending resolver is invoked with cancel=true so no
      // orchestration dispatch is left hanging past shutdown.
      const { clearAllPendingDispatches } = await import('./auto-dispatch-state.js')
      clearAllPendingDispatches()
      // UPDATE-07: Wait for in-flight turns to complete (max 30s)
      if (hasPendingTurns()) {
        log('info', { module: 'discord-bot', source: 'discord', timeoutMs: 30_000 }, 'waiting for in-flight turns')
        await drainAllTurns(30_000)
      }
      client.destroy()
      resolve()
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
  })
}
