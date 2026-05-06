/**
 * Phase 69 (TGCORE-01..05): `tm telegram` subcommand entry point.
 *
 * Loads config, validates TELEGRAM_BOT_TOKEN env, hydrates per-chat
 * ConversationManager from JSONL sessions, loads per-agent memory
 * (agentName: 'telegram'), and starts the grammy bot with an onMessage
 * handler keyed on String(ctx.chat.id).
 *
 * Phase 70 (TGAGENT-01..04): replaced Phase 69 placeholder onMessage with the
 * real agent loop. Constructs provider + registry + mcpManager mirroring
 * src/discord/index.ts (minimal — no health check, no daily DM scheduler,
 * no startup DM, no token budget). Passes handleTelegramMessage(deps) as
 * the onMessage handler to startTelegramBot.
 *
 * Phase 71 (TGCMDS-02, TGNOTIF-01..03): captures loadSharedContext result
 * into TelegramRunnerDeps.sharedContext (for /context handler), constructs
 * onStart callback that registers BotFather commands, sends startup DM,
 * starts daily-dm scheduler, starts tool-error watcher, and seeds the
 * tool-error ring buffer from the last 1h of audit JSONL.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { telegramInstall, telegramUninstall } from './launchd.js'
import { realRunner } from '../agent-runner/launchctl.js'
import { ConversationManager } from '../discord/conversation.js'
import { loadMapping, hydrateConversations } from './session-bridge.js'
import { startTelegramBot, type TelegramBotApi } from './bot.js'
import { loadSharedContext } from '../context/loader.js'
import { createProvider } from '../providers/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildAllTools } from '../tools/builtin/index.js'
import { McpManager } from '../mcp/manager.js'
import {
  resolveActiveProfile,
  filterMcpServersByProfile,
  filterCliToolsByProfile,
  resolveEffectiveProvider,
} from '../config/profile.js'
import { handleTelegramMessage, type TelegramRunnerDeps } from './runner.js'
import { auditPath, parseAuditLine, type AuditEntry } from '../security/audit.js'
import { replay as replayToolErrorMetric } from '../security/tool-error-metrics.js'
import { buildStartupDm } from '../discord/startup-dm.js'
import { startTelegramDailyDmScheduler } from './daily-dm.js'
import { createTelegramToolErrorAlertWatcher } from './tool-error-alerts.js'

// ── Private helpers (mirrored from discord/index.ts) ─────────────────────────

/**
 * Phase 71 (TGNOTIF-03): Rebuild the tool-error metric ring buffer from the
 * last 1h of audit JSONL so the watcher sees history across bot restarts.
 * Module tag: 'telegram-tool-error-alerts'.
 * Copied from src/discord/index.ts ~lines 88-119; source tag changed.
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
    process.stderr.write(`[telegram-tool-error-alerts] replayed ${entries.length} tool_error rows from last 1h\n`)
  }
}

/**
 * Phase 71: Combine multiple stoppables into a single {stop} so the
 * shutdown path can clean up both the daily-dm scheduler and the
 * tool-error alert watcher.
 * Copied verbatim from src/discord/index.ts ~lines 126-140.
 */
function combineStoppables(handles: Array<{ stop: () => void }>): { stop: () => void } {
  return {
    stop: () => {
      for (const h of handles) {
        try {
          h.stop()
        } catch (err) {
          process.stderr.write(
            `[telegram] stop handle failed: ${err instanceof Error ? err.message : String(err)}\n`,
          )
        }
      }
    },
  }
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface RunTelegramDeps {
  loadConfig?: typeof loadConfig
  loadMapping?: typeof loadMapping
  hydrateConversations?: typeof hydrateConversations
  startTelegramBot?: typeof startTelegramBot
  loadSharedContext?: typeof loadSharedContext
  exit?: (code: number) => never
  stderr?: { write: (s: string) => void }
  createProvider?: typeof createProvider
  /** For tests to inject a custom handler factory instead of the real one. */
  buildHandler?: typeof handleTelegramMessage
}

export async function runTelegramSubcommand(
  argv: string[],
  deps: RunTelegramDeps = {},
): Promise<void> {
  const _loadConfig = deps.loadConfig ?? loadConfig
  const _loadMapping = deps.loadMapping ?? loadMapping
  const _hydrateConversations = deps.hydrateConversations ?? hydrateConversations
  const _startTelegramBot = deps.startTelegramBot ?? startTelegramBot
  const _loadSharedContext = deps.loadSharedContext ?? loadSharedContext
  const _exit = deps.exit ?? ((code: number) => process.exit(code))
  const _stderr = deps.stderr ?? process.stderr

  const sub = argv[0]
  if (sub === '--help' || sub === '-h') {
    _stderr.write(
      'Usage: tm telegram [subcommand]\n\n' +
      'Subcommands:\n' +
      '  install            Generate launchd plist and load the Telegram bot service\n' +
      '  uninstall          Unload and remove the launchd plist (idempotent)\n\n' +
      'Without a subcommand: start the Telegram bot in the foreground (long-polling).\n\n' +
      'Configuration:\n' +
      '  Set telegram.tokenEnv and telegram.ownerChatId in ~/.telemachus/config.json.\n' +
      '  Then export the token env var (e.g. TELEGRAM_BOT_TOKEN=...).\n'
    )
    _exit(0)
    return
  }

  if (sub === 'install') {
    const config = await _loadConfig(process.cwd())
    if (!config.telegram) {
      _stderr.write(
        'Error: no "telegram" section in config.\n' +
        'Add telegram.tokenEnv and telegram.ownerChatId to ~/.telemachus/config.json.\n'
      )
      _exit(1)
      return
    }
    // TGDEPLOY-03: token + owner-chat-id are not embedded in the plist. The
    // launcher wrapper (scripts/kc-telegram-launcher.sh) reads both from
    // macOS Keychain. Note when neither env var is set in the current shell —
    // it's only informational since launchd reads from Keychain at launch time.
    const tokenEnvName = config.telegram.tokenEnv
    if (!process.env[tokenEnvName]) {
      _stderr.write(
        `Note: ${tokenEnvName} is not set in the current environment. ` +
        `That's OK if you've already run scripts/setup-keychain.sh — the ` +
        `launcher wrapper reads the token from Keychain at launch. See ` +
        `docs/keychain.md for setup.\n`
      )
    }
    const repoLauncherSource = path.join(process.cwd(), 'scripts', 'kc-telegram-launcher.sh')
    const launcherExists = await stat(repoLauncherSource).then(() => true).catch(() => false)
    const result = await telegramInstall(
      realRunner,
      {
        launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
        homedir: os.homedir(),
      },
      launcherExists ? { launcherSource: repoLauncherSource } : {},
    )
    _stderr.write(
      `Telegram bot ${result.action}: ${result.plistPath}\n` +
      `Label: ${result.label}\n`
    )
    _exit(0)
    return
  }

  if (sub === 'uninstall') {
    const result = await telegramUninstall(
      realRunner,
      {
        launchAgentsDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
        homedir: os.homedir(),
      },
    )
    if (result.action === 'not installed') {
      _stderr.write('Telegram bot is not installed (nothing to do).\n')
    } else {
      _stderr.write('Telegram bot uninstalled.\n')
    }
    _exit(0)
    return
  }

  const config = await _loadConfig(process.cwd())
  if (!config.telegram) {
    _stderr.write(
      'Error: no "telegram" section in config.\n' +
      'Add telegram.tokenEnv and telegram.ownerChatId to ~/.telemachus/config.json.\n'
    )
    _exit(1)
    return
  }

  const tokenEnvName = config.telegram.tokenEnv
  const token = process.env[tokenEnvName]
  if (!token) {
    _stderr.write(`Error: ${tokenEnvName} not set in environment.\n`)
    _exit(1)
    return
  }

  // Phase 71 (TGCMDS-02): capture loadSharedContext return value so /context
  // can render per-file token estimates.
  const sharedContext = await _loadSharedContext({ cwd: process.cwd(), agentName: 'telegram' })

  // TGCORE-02: per-chat ConversationManager
  const conversations = new ConversationManager(config.telegram.maxConversationTurns)

  // TGCORE-05: hydrate from JSONL on startup
  const mapping = await _loadMapping()
  await _hydrateConversations(conversations, mapping)
  const hydratedCount = Object.keys(mapping).length
  if (hydratedCount > 0) {
    _stderr.write(`[telegram] hydrated ${hydratedCount} session(s) from disk\n`)
  }

  // Phase 70: provider + registry + MCP manager (mirrors discord/index.ts, minimal).
  const activeProfile = resolveActiveProfile(config, config.telegram.profile, undefined)
  const effective = resolveEffectiveProvider(config, activeProfile)

  // TRANS-03: load per-transport model state on startup
  const telegramModelStatePath = path.join(os.homedir(), '.telemachus', 'telegram-model-state.json')
  let telegramModelStateOverride: { provider?: string; model?: string } = {}
  try {
    if (existsSync(telegramModelStatePath)) {
      telegramModelStateOverride = JSON.parse(readFileSync(telegramModelStatePath, 'utf-8')) as { provider?: string; model?: string }
    }
  } catch { /* ignore corrupt state */ }
  const effectiveWithState = {
    ...effective,
    ...(telegramModelStateOverride.provider ? { provider: telegramModelStateOverride.provider as typeof effective.provider } : {}),
    ...(telegramModelStateOverride.model ? { model: telegramModelStateOverride.model } : {}),
  }
  process.stderr.write(
    `Telegram model: ${effectiveWithState.model} via ${effectiveWithState.provider}` +
    (activeProfile ? ` [profile: ${activeProfile}]` : '') + '\n'
  )

  const model = effectiveWithState.model

  // Build the onMessage handler.
  // When deps.startTelegramBot is injected (lifecycle test mode) and deps.createProvider
  // is not, we skip provider construction — the mocked startTelegramBot never
  // invokes the handler so no real provider is needed.
  // deps.buildHandler lets runner unit tests supply their own handler factory.
  const isLifecycleTestMode = deps.startTelegramBot !== undefined && deps.createProvider === undefined && deps.buildHandler === undefined
  let onMessage: (ctx: import('grammy').Context) => Promise<void>

  if (isLifecycleTestMode) {
    // Lifecycle test mode (Phase 69 tests): real provider not needed.
    const noopRegistry = new ToolRegistry()
    const noopDeps: TelegramRunnerDeps = {
      config,
      provider: null as never,
      registry: noopRegistry,
      conversations,
      sessionMapping: mapping,
      model,
      sharedContext,  // Phase 71 (TGCMDS-02)
    }
    onMessage = handleTelegramMessage(noopDeps)
  } else if (deps.buildHandler) {
    // Runner unit test mode: caller supplies its own handler factory.
    const noopRegistry = new ToolRegistry()
    const noopDeps: TelegramRunnerDeps = {
      config,
      provider: null as never,
      registry: noopRegistry,
      conversations,
      sessionMapping: mapping,
      model,
      sharedContext,  // Phase 71 (TGCMDS-02)
    }
    onMessage = deps.buildHandler(noopDeps)
  } else {
    // Production path: build real provider, registry, and MCP manager.
    const configForProvider = {
      ...config,
      providerConfigs: config.providerConfigs ?? ({} as NonNullable<typeof config.providerConfigs>),
      // Apply profile provider/model overrides + model-state override (mirrors discord/index.ts kcConfig assembly)
      ...(effectiveWithState.provider !== config.provider && { provider: effectiveWithState.provider }),
      ...(effectiveWithState.model !== config.model && { model: effectiveWithState.model }),
    }
    const provider = createProvider(configForProvider)
    const filteredMcp = filterMcpServersByProfile(config, activeProfile)
    const filteredCli = filterCliToolsByProfile(config, activeProfile)

    const mcpManager = new McpManager({
      config: {
        ...config,
        ...(filteredMcp !== undefined ? { mcpServers: filteredMcp } : {}),
        ...(filteredCli !== undefined ? { cliTools: filteredCli } : {}),
      },
      registry: new ToolRegistry(),
      sessionId: `telegram-${Date.now()}`,
      mode: 'agent',
    })

    const registry = new ToolRegistry()
    const tools = buildAllTools(
      {
        ...config,
        ...(filteredCli !== undefined ? { cliTools: filteredCli } : {}),
      },
      null,
    )
    for (const t of tools) registry.register(t)

    // TRAJ-03: load trajectory bias cache at startup (fire off async read)
    const { loadBiasCache } = await import('../shared/trajectory.js')
    const biasCache = await loadBiasCache()
    process.stderr.write(`[telegram] bias cache loaded (${biasCache.snapshot().size} intent-transport factors)\n`)

    // Phase 74 (ROUTE-06): wire RouterProvider into Telegram when routerConfig is present.
    // Mirrors discord/index.ts RouterProvider assembly logic.
    const activeProfileConfig = activeProfile ? config.profiles?.[activeProfile] : undefined
    let finalProvider: import('../providers/types.js').Provider = provider
    if (activeProfileConfig?.routerConfig) {
      const { assembleRouterProvider } = await import('../discord/router-assembly.js')
      const { getOrCreateSemaphore } = await import('../providers/registry.js')
      const semaphore = getOrCreateSemaphore(configForProvider)
      finalProvider = assembleRouterProvider(configForProvider, activeProfileConfig.routerConfig, semaphore, biasCache)
      process.stderr.write(`[telegram] RouterProvider active (${activeProfile})\n`)
    }

    const runnerDeps: TelegramRunnerDeps = {
      config,
      provider: finalProvider,
      registry,
      conversations,
      sessionMapping: mapping,
      model,
      mcpManager: undefined,  // v3.9: MCP lifecycle not wired for Telegram yet
      sharedContext,  // Phase 71 (TGCMDS-02)
    }
    onMessage = handleTelegramMessage(runnerDeps)
    void mcpManager // suppress unused warning — future phases wire lifecycle
  }

  // ── Phase 71: build onStart callback ──────────────────────────────────────
  //
  // Reads package version from package.json (readFileSync pattern — not a
  // dynamic import so it works at startup without module cache issues).
  // v3.9: static llmHealth=ok — no live LLM ping; v3.10 will add real check.

  let pkgVersion = 'dev'
  try {
    const repoRoot = (() => {
      try { return dirname(realpathSync(process.execPath)) } catch { return resolve(import.meta.dir, '../..') }
    })()
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { version?: string }
    if (pkg.version) pkgVersion = pkg.version
  } catch {
    // fallback to 'dev'
  }
  let commitHash = 'unknown'
  try {
    const repoRootForGit = (() => {
      try { return dirname(realpathSync(process.execPath)) } catch { return resolve(import.meta.dir, '../..') }
    })()
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repoRootForGit })
    commitHash = new TextDecoder().decode(proc.stdout).trim() || 'unknown'
  } catch { /* fallback to 'unknown' */ }
  const llmHealthResult: { ok: boolean; error?: string } = { ok: true }

  const onStart = async (
    sendMessage: (text: string) => Promise<void>,
    botApi: TelegramBotApi,
  ): Promise<void> => {
    // Replay last 1h of audit tool_error rows — fire and forget (TGNOTIF-03).
    void replayToolErrors().catch((err) => {
      process.stderr.write(
        `[telegram-tool-error-alerts] replay failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })

    // Register slash commands with BotFather so they appear as autocomplete.
    // Wrapped in try/catch — a transient API error must not block startup DM.
    try {
      await botApi.setMyCommands([
        { command: 'cost',        description: 'Session token count and USD estimate' },
        { command: 'context',     description: 'Loaded context files with token estimates' },
        { command: 'compact',     description: 'On-demand context window summarisation' },
        { command: 'model',       description: 'Switch active model mid-session' },
        { command: 'clear',       description: 'Reset context window' },
        { command: 'orchestrate', description: 'Run orchestration in autonomous mode' },
        { command: 'tool_errors', description: 'Recent tool failure counts' },
      ])
    } catch (err) {
      process.stderr.write(
        `[telegram] setMyCommands failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }

    // Startup DM (TGNOTIF-02).
    try {
      const dmText = buildStartupDm({
        version: pkgVersion,
        commitHash,
        timestamp: new Date().toISOString(),
        llmHealth: llmHealthResult,
      })
      await sendMessage(dmText)
    } catch (err) {
      process.stderr.write(
        `[telegram] startup DM failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }

    // Daily DM scheduler (TGNOTIF-01).
    const dailyScheduler = startTelegramDailyDmScheduler({
      sendMessage,
      model,
      targetHour: 7,
    })

    // Tool-error alert watcher (TGNOTIF-03).
    const watcher = createTelegramToolErrorAlertWatcher({ sendMessage })
    watcher.start()

    const shutdownHandles = combineStoppables([dailyScheduler, watcher])

    // Wire shutdown — stops both schedulers on SIGTERM/SIGINT.
    const onShutdown = (): void => { shutdownHandles.stop() }
    process.once('SIGTERM', onShutdown)
    process.once('SIGINT', onShutdown)
  }

  await _startTelegramBot({ telegramConfig: config.telegram, onMessage, onStart })
}
