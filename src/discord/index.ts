/**
 * Phase 31: `tm discord` subcommand dispatcher.
 * Branches here BEFORE the interactive TTY guard in src/index.ts.
 *
 * Phase 31 additions over Phase 30:
 *   - Constructs Provider, ToolRegistry, McpManager before bot start
 *   - Passes handleDiscordMessage as the onMessage handler
 *   - Profile logging (CFG-01) emitted here before the bot connects
 *
 * Phase 34 additions (OPS-01–OPS-04):
 *   - install / uninstall subcommand routing (OPS-01, OPS-02)
 *   - LLM health check before startDiscordBot (OPS-04)
 *
 * Phase 35 additions (TOKEN-05):
 *   - Daily DM scheduler started via onReady callback (TOKEN-05)
 *
 * Phase 36 additions (UPDATE-06, UPDATE-07):
 *   - Startup notification DM via onStartup callback (UPDATE-06)
 *   - Graceful drain on SIGTERM via drain imports (UPDATE-07)
 *
 * Phase 37-02 additions (UPDATE-04, UPDATE-05):
 *   - webhook install/uninstall/serve subcommand routing (UPDATE-05)
 *   - webhook serve starts HTTP listener as launchd service (UPDATE-04)
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildAllTools } from '../tools/builtin/index.js'
import { maybeLoadIndexClient } from '../project-index/maybe-load.js'
import {
  resolveActiveProfile,
  filterMcpServersByProfile,
  filterCliToolsByProfile,
  resolveEffectiveProvider,
} from '../config/profile.js'
import { McpManager } from '../mcp/manager.js'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { startDiscordBot } from './bot.js'
import { startDailyDmScheduler } from './daily-dm.js'
import { createToolErrorAlertWatcher } from './tool-error-alerts.js'
import { replay as replayToolErrorMetric } from '../security/tool-error-metrics.js'
import { auditPath, parseAuditLine, type AuditEntry } from '../security/audit.js'
import { readFile, stat } from 'node:fs/promises'
import { buildStartupDm } from './startup-dm.js'
import { ConversationManager } from './conversation.js'
import { handleDiscordMessage } from './runner.js'
import { DiscordTokenBudget } from './token-budget.js'
import { loadMapping, hydrateConversations } from './session-bridge.js'
import { discordInstall, discordUninstall } from './launchd.js'
import { realRunner } from '../agent-runner/launchctl.js'
import { checkLlmEndpoint } from './health-check.js'
import { getActiveEscalationHandler } from '../orchestration/discord.js'
import { loadSharedContext } from '../context/loader.js'
import { assembleSystemPrompt } from './persona.js'

/**
 * Build base system prompt by loading all shared context files (CLAUDE.md hierarchy,
 * AGENTS.md fallback, KC_MEMORY.md / MEMORY.md) from the project directory.
 * Replaces the old single-file reader with the full hierarchical loader so
 * Discord sessions get the same context as CLI sessions (Phase 46, CTX-01..02).
 *
 * Phase 64 (PERS-01): renamed from buildSystemPrompt to buildBaseSystemPrompt —
 * returns only the channel-agnostic prefix (base + shared context). Per-channel
 * persona injection happens in the builder wired into DiscordRunnerDeps.systemPrompt.
 */
async function buildBaseSystemPrompt(projectDir: string): Promise<string> {
  const base = 'You are a helpful assistant accessible via Discord. Be concise — Discord messages have a 2000 character limit. Use tools when needed.'
  // Phase 67 (AGMEM-03): pass agentName: 'discord' so per-agent memory from
  // ~/.telemachus/agent-memory/discord/MEMORY.md is loaded when present.
  const ctx = await loadSharedContext({ cwd: projectDir, agentName: 'discord' })
  if (ctx.systemPromptPrefix) {
    return `${base}\n\n${ctx.systemPromptPrefix}`
  }
  return base
}

/**
 * Phase 63 (OBS-03): Rebuild the tool-error metric ring buffer from the last
 * 1h of audit JSONL so the watcher sees history across bot restarts. Reads
 * today's and yesterday's files (yesterday covers the case where the last
 * hour spans a UTC midnight boundary). Best-effort — missing files, parse
 * errors, and disk errors are all silently swallowed so a corrupted audit
 * line cannot prevent the bot from starting.
 */
async function replayToolErrors(): Promise<void> {
  const now = Date.now()
  const oneHourAgo = now - 60 * 60 * 1000
  const today = new Date(now)
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  const paths = [auditPath(yesterday), auditPath(today)]
  const entries: AuditEntry[] = []
  for (const p of paths) {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue // missing file — expected on first day
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const entry = parseAuditLine(line)
        if (entry.kind !== 'tool_error') continue
        const ts = Date.parse(entry.ts)
        if (Number.isNaN(ts) || ts < oneHourAgo) continue
        entries.push(entry)
      } catch {
        // unparseable line — skip silently
      }
    }
  }
  if (entries.length > 0) {
    replayToolErrorMetric(entries)
    process.stderr.write(`[tool-error-alerts] replayed ${entries.length} tool_error rows from last 1h\n`)
  }
}

/**
 * Phase 63 (OBS-03): Combine multiple stoppables into a single {stop} so the
 * bot's onReady lifecycle can return one handle covering both the daily-dm
 * scheduler AND the tool-error alert watcher.
 */
function combineStoppables(handles: Array<{ stop: () => void }>): { stop: () => void } {
  return {
    stop: () => {
      for (const h of handles) {
        try {
          h.stop()
        } catch (err) {
          process.stderr.write(
            `[discord] stop handle failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    },
  }
}

export async function runDiscordSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0]

  // ————————————————————————————————————————————————————————————————————————
  // Phase 34: install / uninstall subcommands (OPS-01, OPS-02)
  // ————————————————————————————————————————————————————————————————————————

  // ————————————————————————————————————————————————————————————————————————
  // Phase 35-02: usage subcommand (TOKEN-03)
  // ————————————————————————————————————————————————————————————————————————

  if (sub === 'usage') {
    const { runUsageCli } = await import('./usage-cli.js')
    await runUsageCli(argv.slice(1))
    return
  }

  // ————————————————————————————————————————————————————————————————————————
  // Phase 37-02: webhook install / uninstall / serve subcommands (UPDATE-04, UPDATE-05)
  // Must appear before bare 'install'/'uninstall' so 'webhook' is routed correctly.
  // ————————————————————————————————————————————————————————————————————————

  if (sub === 'webhook' && argv[1] === 'install') {
    const config = await loadConfig(process.cwd())
    if (!config.discord?.webhook) {
      process.stderr.write(
        'Error: no "discord.webhook" section in config.\n' +
        'Add discord.webhook.secretEnv to ~/.telemachus/config.json.\n'
      )
      process.exit(1)
    }
    const webhookSecretEnvName = config.discord.webhook.secretEnv
    const webhookSecretValue = process.env[webhookSecretEnvName] ?? ''
    if (!webhookSecretValue) {
      process.stderr.write(
        `Warning: ${webhookSecretEnvName} is not set. The plist will be written but HMAC verification will fail.\n`
      )
    }
    const discordTokenEnvName = config.discord.tokenEnv
    const discordTokenValue = process.env[discordTokenEnvName] ?? ''
    const port = config.discord.webhook.port ?? 9876
    const repoDir = process.env.KC_REPO_DIR ?? process.cwd()

    const { webhookInstall } = await import('./webhook-launchd.js')
    const result = await webhookInstall(
      realRunner,
      { launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'), homedir: os.homedir() },
      { webhookSecretEnvName, webhookSecretValue, discordTokenEnvName, discordTokenValue, port, repoDir }
    )
    process.stderr.write(
      `Webhook service ${result.action}: ${result.plistPath}\n` +
      `Label: ${result.label}\n` +
      `Port: ${port}\n`
    )
    process.exit(0)
  }

  if (sub === 'webhook' && argv[1] === 'uninstall') {
    const { webhookUninstall } = await import('./webhook-launchd.js')
    const result = await webhookUninstall(
      realRunner,
      { launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'), homedir: os.homedir() }
    )
    if (result.action === 'not installed') {
      process.stderr.write('Webhook service is not installed (nothing to do).\n')
    } else {
      process.stderr.write('Webhook service uninstalled.\n')
    }
    process.exit(0)
  }

  if (sub === 'webhook' && argv[1] === 'serve') {
    const webhookSecret = process.env.KC_WEBHOOK_SECRET ?? ''
    const port = parseInt(process.env.KC_WEBHOOK_PORT ?? '9876', 10)
    const repoDir = process.env.KC_REPO_DIR ?? process.cwd()
    const discordTokenEnv = 'KC_DISCORD_TOKEN'

    const config = await loadConfig(process.cwd())
    const ownerId = config.discord?.allowedUsers[0] ?? ''

    if (!webhookSecret) {
      process.stderr.write('Error: webhook secret not configured. Set KC_WEBHOOK_SECRET env var.\n')
      process.exit(1)
    }

    const { startWebhookServer } = await import('./webhook-server.js')
    const { server } = startWebhookServer({
      webhookSecret,
      port,
      // Defensive: user may write `main` OR the fully-qualified `refs/heads/main`
      // in their config. Strip the prefix if present, then re-apply, so both work.
      // (This was a real foot-gun: a value of `refs/heads/main` would become
      // `refs/heads/refs/heads/main` and every GitHub push would be silently
      // `ignored` at the ref-filter gate.)
      targetRef: (() => {
        const raw = config.discord?.webhook?.branch ?? 'main'
        const stripped = raw.replace(/^refs\/heads\//, '')
        return `refs/heads/${stripped}`
      })(),
      repoDir,
      discordTokenEnv,
      ownerId,
    })

    process.stderr.write(`Webhook: listening on 127.0.0.1:${port}\n`)

    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => { server.stop(); resolve() })
      process.on('SIGTERM', () => { server.stop(); resolve() })
    })
    process.exit(0)
  }

  if (sub === 'install') {
    const config = await loadConfig(process.cwd())
    if (!config.discord) {
      process.stderr.write(
        'Error: no "discord" section in config.\n' +
        'Add discord.tokenEnv to ~/.telemachus/config.json.\n'
      )
      process.exit(1)
    }
    // HYG-04: token is no longer embedded in the plist. The launcher
    // wrapper (scripts/kc-discord-launcher.sh) reads from macOS Keychain.
    // Advise the user to run setup-keychain.sh if the entry is missing.
    const tokenEnvName = config.discord.tokenEnv
    if (!process.env[tokenEnvName]) {
      process.stderr.write(
        `Note: ${tokenEnvName} is not set in the current environment. ` +
        `That's OK if you've already run scripts/setup-keychain.sh — the ` +
        `launcher wrapper reads the token from Keychain at launch. See ` +
        `docs/keychain.md for setup.\n`
      )
    }
    // Launcher source lives in the repo at scripts/kc-discord-launcher.sh.
    // When kc is invoked from the repo checkout, process.cwd() is the repo
    // root; in packaged installs, the launcher must already exist at the
    // destination (omit launcherSource and skip the copy).
    const repoLauncherSource = path.join(process.cwd(), 'scripts', 'kc-discord-launcher.sh')
    const launcherExists = await stat(repoLauncherSource).then(() => true).catch(() => false)
    const result = await discordInstall(
      realRunner,
      {
        launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
        homedir: os.homedir(),
      },
      launcherExists ? { launcherSource: repoLauncherSource } : {},
    )
    process.stderr.write(
      `Discord bot ${result.action}: ${result.plistPath}\n` +
      `Label: ${result.label}\n`
    )
    process.exit(0)
  }

  if (sub === 'uninstall') {
    const result = await discordUninstall(
      realRunner,
      {
        launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
        homedir: os.homedir(),
      },
    )
    if (result.action === 'not installed') {
      process.stderr.write('Discord bot is not installed (nothing to do).\n')
    } else {
      process.stderr.write('Discord bot uninstalled.\n')
    }
    process.exit(0)
  }

  if (sub === '--help' || sub === '-h') {
    process.stderr.write(
      'Usage: tm discord [subcommand]\n\n' +
      'Subcommands:\n' +
      '  install            Generate launchd plist and load the Discord bot service\n' +
      '  uninstall          Unload and remove the launchd plist (idempotent)\n' +
      '  usage              Show aggregated token usage (--today, --week, --month, --all, --json)\n' +
      '  webhook install    Install the GitHub webhook auto-update service (launchd)\n' +
      '  webhook uninstall  Uninstall the webhook service\n' +
      '  webhook serve      Start webhook server in foreground (used by launchd)\n\n' +
      'Without a subcommand: start the Discord bot in the foreground.\n\n' +
      'Configuration:\n' +
      '  Set discord.tokenEnv, discord.allowedUsers, and optionally\n' +
      '  discord.profile in ~/.telemachus/config.json.\n' +
      '  Then set the token env var (e.g. KC_DISCORD_TOKEN=...).\n'
    )
    process.exit(0)
  }

  // Default action: start the bot (no subcommand needed — `tm discord` starts it)
  const config = await loadConfig(process.cwd())

  if (!config.discord) {
    process.stderr.write(
      'Error: no "discord" section in config.\n' +
      'Add discord.tokenEnv and discord.allowedUsers to ~/.telemachus/config.json.\n'
    )
    process.exit(1)
  }

  if (config.discord.allowedUsers.length === 0) {
    process.stderr.write(
      'Error: discord.allowedUsers is empty — bot would ignore all messages.\n' +
      'Add at least one Discord user ID to the allowlist.\n'
    )
    process.exit(1)
  }

  // Profile resolution — same pattern as agent-runner/index.ts
  const activeProfileName = resolveActiveProfile(config, config.discord.profile, undefined)
  const filteredMcpServers = filterMcpServersByProfile(config, activeProfileName)
  const filteredCliTools = filterCliToolsByProfile(config, activeProfileName)

  // CFG-01 / D-03: Log effective provider/model before connecting to gateway
  const effectiveBase = resolveEffectiveProvider(config, activeProfileName)

  // discord-model-state.json override: written by !model command to switch provider/model at runtime
  const modelStatePath = path.join(os.homedir(), '.telemachus', 'discord-model-state.json')
  let modelStateOverride: { provider?: string; model?: string } = {}
  if (existsSync(modelStatePath)) {
    try { modelStateOverride = JSON.parse(readFileSync(modelStatePath, 'utf-8')) } catch { /* ignore corrupt state */ }
  }
  const effective = {
    ...effectiveBase,
    ...(modelStateOverride.provider ? { provider: modelStateOverride.provider as typeof effectiveBase.provider } : {}),
    ...(modelStateOverride.model ? { model: modelStateOverride.model } : {}),
  }
  process.stderr.write(
    `Discord model: ${effective.model} via ${effective.provider}` +
    (activeProfileName ? ` [profile: ${activeProfileName}]` : '') + '\n'
  )

  const kcConfig = {
    ...config,
    mcpServers: filteredMcpServers,
    cliTools: filteredCliTools,
    // Apply profile provider/model overrides to top-level config
    ...(effective.provider !== config.provider && { provider: effective.provider }),
    ...(effective.model !== config.model && { model: effective.model }),
  }

  // UPDATE-06: Read version and commit hash for startup DM.
  // In a compiled Bun binary, import.meta.dir and Bun.main are virtual embedded paths.
  // process.execPath is the actual binary on disk — use dirname to find the repo root.
  const repoRoot = (() => {
    try { return path.dirname(realpathSync(process.execPath)) } catch { return resolve(import.meta.dir, '../..') }
  })()

  let pkgVersion = 'unknown'
  try {
    pkgVersion = (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version
  } catch { /* fallback to 'unknown' */ }

  let commitHash = 'unknown'
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
    commitHash = new TextDecoder().decode(proc.stdout).trim() || 'unknown'
  } catch { /* git not available */ }

  // OPS-04: Check LLM endpoint reachability — warning only, does not block gateway connect
  // UPDATE-06: capture result for startup DM health indicator
  let llmHealthResult: { ok: boolean; error?: string } = { ok: true }
  const providerConfig = kcConfig.providerConfigs?.[effective.provider]
  const baseURL = providerConfig?.baseURL ?? (effective.provider === 'llamacpp' ? 'http://localhost:8080/v1' : null)
  if (baseURL) {
    // Pass apiKey so the probe includes auth — providers like Z.ai return 401
    // for unauthenticated GET /models even when the endpoint is healthy.
    llmHealthResult = await checkLlmEndpoint(baseURL, 5000, providerConfig?.apiKey)
    if (!llmHealthResult.ok) {
      process.stderr.write(
        `Warning: LLM endpoint unreachable at ${baseURL}: ${llmHealthResult.error}\n` +
        `Bot will start anyway — LLM requests may fail until the endpoint is available.\n`
      )
    } else {
      process.stderr.write(`LLM endpoint OK: ${baseURL}\n`)
    }
  }

  let provider = createProvider(kcConfig)

  // TRAJ-03: load trajectory bias cache at startup (fire off async read)
  const { loadBiasCache } = await import('../shared/trajectory.js')
  const biasCache = await loadBiasCache()
  process.stderr.write(`[discord] bias cache loaded (${biasCache.snapshot().size} intent-transport factors)\n`)

  // Phase 59 (ROUTE-06, ROUTE-07): Discord-only RouterProvider assembly.
  // Only wraps when the active profile declares routerConfig. CLI entry points
  // never read this field, so createProvider is untouched by this change.
  const activeProfile = activeProfileName ? config.profiles?.[activeProfileName] : undefined
  if (activeProfile?.routerConfig) {
    const { assembleRouterProvider } = await import('./router-assembly.js')
    const { getOrCreateSemaphore } = await import('../providers/registry.js')
    provider = assembleRouterProvider(kcConfig, activeProfile.routerConfig, getOrCreateSemaphore(kcConfig), biasCache)
    process.stderr.write(`[router] RouterProvider active: classifier=${activeProfile.routerConfig.classifier}, simple=${activeProfile.routerConfig.simple}, complex=${activeProfile.routerConfig.complex}\n`)
  }

  // v3.1 Phase 51: pass optional IndexClient for index-aware glob/grep.
  const loadedIndex = await maybeLoadIndexClient()
  const registry = new ToolRegistry()
  registry.registerAll(buildAllTools(kcConfig, loadedIndex?.client ?? null))

  const sessionId = `discord-${Date.now()}`
  const mcpManager = new McpManager({
    config: kcConfig,
    registry,
    sessionId,
    mode: 'agent',
  })

  // Load eager MCP servers — failures are warnings not fatal errors
  try {
    const counts = await mcpManager.loadEager()
    process.stderr.write(
      `[mcp] loaded: ${counts.eagerCount} eager, ${counts.lazyCount} lazy\n`
    )
  } catch (err) {
    process.stderr.write(
      `[mcp] warning: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }

  // Cleanup MCP on shutdown (mirrors agent-runner pattern)
  const cleanup = async () => {
    try { await mcpManager.dispose() } catch {}
  }
  process.on('SIGINT', () => void cleanup())
  process.on('SIGTERM', () => void cleanup())

  const sessionMapping = await loadMapping()
  const conversations = new ConversationManager(config.discord?.maxConversationTurns)
  await hydrateConversations(conversations, sessionMapping)
  const hydratedCount = Object.keys(sessionMapping).length
  if (hydratedCount > 0) {
    process.stderr.write(`[discord] hydrated ${hydratedCount} session(s) from disk\n`)
  }

  // Phase 40-03 (ENTRY-03): Mutable holder for sendDm so runner.ts can pass
  // it to !orchestrate commands. Set when ClientReady fires via onReady callback.
  let activeSendDm: ((userId: string, text: string) => Promise<void>) | undefined
  const ownerId = config.discord!.allowedUsers[0]!

  // BUDGET-01: construct per-user daily token budget from config (default 1_000_000)
  const tokenBudget = new DiscordTokenBudget({
    dailyTokens: config.discord?.dailyTokensPerUser ?? 1_000_000,
  })

  // Phase 64 (PERS-01): assemble base prompt once at startup, but wrap in a
  // per-channel builder so each incoming message resolves its persona fresh.
  // Persona config reloads take effect for the next incoming message without
  // a bot restart (the builder re-reads config.discord on every call).
  const basePrompt = await buildBaseSystemPrompt(process.cwd())
  const systemPromptBuilder = (channelId: string): string =>
    assembleSystemPrompt(channelId, basePrompt, config.discord)

  const onMessage = handleDiscordMessage({
    config: kcConfig,
    provider,
    registry,
    conversations,
    systemPrompt: systemPromptBuilder,
    sessionMapping,
    model: effective.model,
    // Phase 33 (JOB-01): pass mcpManager so !run commands can use MCP tools
    mcpManager,
    // Phase 40-03: thread sendDm lazily — activeSendDm is set when gateway connects
    get sendDm() { return activeSendDm },
    ownerId,
    // BUDGET-01: daily per-user token budget gate
    tokenBudget,
  })

  try {
    await startDiscordBot({
      config: kcConfig,
      discordConfig: config.discord,
      onMessage,
      // TOKEN-05: Start daily DM scheduler when the client is ready
      // Phase 63 (OBS-03): Also start the tool-error alert watcher + replay
      // last 1h of audit rows into the ring buffer before the first tick.
      onReady: (sendDm) => {
        // Phase 40-03: Store sendDm so !orchestrate commands can use it for DM escalation
        activeSendDm = sendDm
        // Replay is fire-and-forget — we don't want to block gateway connect
        // on a slow disk, and the first watcher tick runs 60s later anyway.
        void replayToolErrors().catch((err) => {
          process.stderr.write(
            `[tool-error-alerts] replay failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        })
        const dailyScheduler = startDailyDmScheduler({
          sendDm,
          ownerId,
          pricing: config.discord?.pricing,
          model: effective.model,
          targetHour: config.discord?.usageHour ?? 7,
        })
        const watcher = createToolErrorAlertWatcher({
          sendDm,
          ownerId,
          ...(config.discord?.toolErrorAlerts !== undefined && { config: config.discord.toolErrorAlerts }),
        })
        watcher.start()
        return combineStoppables([dailyScheduler, watcher])
      },
      // UPDATE-06: Send startup DM to owner on gateway connect
      onStartup: async (sendDm) => {
        const ownerId = config.discord!.allowedUsers[0]!
        const dmText = buildStartupDm({
          version: pkgVersion,
          commitHash,
          timestamp: new Date().toISOString(),
          llmHealth: llmHealthResult,
        })
        await sendDm(ownerId, dmText)
      },
      // Phase 40-03 (ENTRY-03): Provide escalation handler getter for DM reply routing
      getEscalationHandler: () => getActiveEscalationHandler(),
    })
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`
    )
    await cleanup()
    process.exit(1)
  }
}
