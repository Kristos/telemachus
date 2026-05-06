/**
 * Phase 33-01 (JOB-01, JOB-02, JOB-03): Discord command dispatcher.
 *
 * Handles `!run <job>` and `!status [job]` commands intercepted from
 * handleDiscordMessage before the agent loop runs.
 *
 * !run <job>   — Triggers a background agent job by name. Replies immediately
 *               with a confirmation, then fires runJob in background. On
 *               completion, calls onJobComplete so the result can be posted.
 *
 * !status [job] — Reads run history from artifact directory via loadStatusRows.
 *                With no name: shows last 10 runs across all jobs.
 *                With a name: shows last 5 runs for that job.
 *
 * IMPORTANT: This module does NOT import from discord.js. All Discord
 * interaction goes through the DiscordMessage interface from runner.ts.
 */
import { homedir } from 'node:os'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '../providers/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import type { DiscordMessage } from './runner.js'
import type { ConversationManager } from './conversation.js'
import type { RunJobMcpManager, RunJobResult } from '../agent-runner/run-job.js'
import { runJob } from '../agent-runner/run-job.js'
import { loadStatusRows, formatDuration, formatStarted } from '../agent-runner/status.js'
import { log } from '../log/logger.js'

export interface CommandDeps {
  /** Full KristosConfig — used to look up config.agents for job dispatch. */
  config: KristosConfig
  provider: Provider
  registry: ToolRegistry
  /** Optional MCP manager passed through to the background job runner. */
  mcpManager?: RunJobMcpManager
  /**
   * Callback invoked when a background !run job finishes (success or error).
   * The caller (runner.ts) uses this to post results to the originating channel.
   */
  onJobComplete: (channelId: string, jobName: string, result: RunJobResult) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): sendDm function for escalation DMs.
   * When provided, !orchestrate runs with human-in-the-loop escalation.
   */
  sendDm?: (userId: string, text: string) => Promise<void>
  /**
   * Phase 40-03 (ENTRY-03): Discord user ID of the bot owner.
   * Required when sendDm is provided for escalation DMs.
   */
  ownerId?: string
  /**
   * Phase 54 (CHAT-01..03): per-channel conversation history store.
   * Threaded through to !orchestrate handlers so orchestration
   * completion/failure can append a structured assistant turn.
   */
  conversations?: ConversationManager
}

/**
 * Returns true if the message content should be handled as a bot command
 * rather than forwarded to the agent loop.
 *
 * Recognized commands:
 *   !run <name>   — requires a job name (whitespace after !run required)
 *   !status       — bare or with optional job name
 *   !usage        — bare command to show today's token totals
 */
export function isCommand(content: string): boolean {
  if (content === '!help' || content.startsWith('!help ')) return true
  if (content.startsWith('!run ')) return true
  if (content === '!status' || content.startsWith('!status ')) return true
  if (content === '!jobs' || content.startsWith('!jobs ')) return true
  if (content === '!usage' || content.startsWith('!usage ')) return true
  if (content === '!index' || content.startsWith('!index ')) return true
  if (content === '!orchestrate-templates' || content.startsWith('!orchestrate-templates ')) return true
  if (content.startsWith('!orchestrate-template ')) return true
  if (content.startsWith('!orchestrate ')) return true
  if (content === '!deploy' || content.startsWith('!deploy ')) return true
  // Phase 63 (OBS-05): !tool-errors info command
  if (content === '!tool-errors' || content.startsWith('!tool-errors ')) return true
  if (content === '!model' || content.startsWith('!model ')) return true
  return false
}

/**
 * Dispatch a recognized command. Always awaitable — the caller in runner.ts
 * should `return` immediately after awaiting this.
 *
 * The !run handler fires the background job without blocking (fire-and-forget
 * pattern). The command returns as soon as the confirmation reply is sent,
 * satisfying the "within 3 seconds" requirement (JOB-01).
 */
export async function handleCommand(msg: DiscordMessage, deps: CommandDeps): Promise<void> {
  const content = msg.content.trim()

  if (content === '!help' || content.startsWith('!help ')) {
    await handleHelp(msg)
    return
  }

  if (content.startsWith('!run')) {
    await handleRun(msg, deps)
    return
  }

  if (content.startsWith('!status')) {
    await handleStatus(msg, deps)
    return
  }

  if (content === '!jobs' || content.startsWith('!jobs ')) {
    await handleJobs(msg, deps)
    return
  }

  if (content.startsWith('!usage')) {
    await handleUsage(msg, deps)
    return
  }

  if (content === '!index' || content.startsWith('!index ')) {
    await handleIndex(msg)
    return
  }

  if (content === '!orchestrate-templates' || content.startsWith('!orchestrate-templates ')) {
    const { handleListTemplatesCommand } = await import('../orchestration/discord.js')
    await handleListTemplatesCommand(msg)
    return
  }

  if (content.startsWith('!orchestrate-template ')) {
    const { handleOrchestrateTemplateCommand } = await import('../orchestration/discord.js')
    await handleOrchestrateTemplateCommand(msg, {
      config: deps.config,
      provider: deps.provider,
      registry: deps.registry,
      sendDm: deps.sendDm,
      ownerId: deps.ownerId,
      // Phase 54: thread conversations for orchestration summary appending
      conversations: deps.conversations,
    })
    return
  }

  if (content.startsWith('!orchestrate')) {
    const { handleOrchestrateCommand } = await import('../orchestration/discord.js')
    await handleOrchestrateCommand(msg, {
      config: deps.config,
      provider: deps.provider,
      registry: deps.registry,
      // Phase 40-03: thread sendDm and ownerId for DM escalation gate
      sendDm: deps.sendDm,
      ownerId: deps.ownerId,
      // Phase 54: thread conversations for orchestration summary appending
      conversations: deps.conversations,
    })
    return
  }

  if (content === '!deploy' || content.startsWith('!deploy ')) {
    const { handleDeployCommand } = await import('./deploy-command.js')
    await handleDeployCommand(msg)
    return
  }

  if (content === '!model' || content.startsWith('!model ')) {
    await handleModel(msg)
    return
  }

  // Phase 63 (OBS-05): on-demand tool-error query
  if (content === '!tool-errors' || content.startsWith('!tool-errors ')) {
    await handleToolErrors(msg)
    return
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// !help implementation
// ─────────────────────────────────────────────────────────────────────────────

async function handleHelp(msg: DiscordMessage): Promise<void> {
  const help = `**Telemachus Commands**

**Chat** — just type naturally, I'm a full coding agent with tools

**Orchestration** (v3.0)
\`!orchestrate <prompt>\` — describe what to build, I decompose + execute
\`!orchestrate --cheap <prompt>\` — all GLM, zero Opus spend
\`!orchestrate <json>\` — run from JSON config directly
\`!orchestrate-template <name>\` — run a project template
\`!orchestrate-templates\` — list available templates

**Agent Jobs**
\`!run <job>\` — trigger a background agent job
\`!status [job]\` — show recent run history
\`!jobs\` — show all configured agents with launchd status + last run

**Info**
\`!usage\` — today's token usage
\`!tool-errors [15m|1h|24h]\` — recent tool failure counts
\`!model [haiku|glm|deepseek]\` — switch active model (haiku = Claude Haiku, glm = GLM-5.1, deepseek = DeepSeek V3)
\`!help\` — this message

**Project Index** (v3.1)
\`!index\` — scan project and update index
\`!index status\` — show index stats (file count, staleness)

**Deploy**
\`!deploy <commit message>\` — commit + push + open PR with approval`

  await msg.reply(help)
}

// ─────────────────────────────────────────────────────────────────────────────
// !run implementation
// ─────────────────────────────────────────────────────────────────────────────

async function handleRun(msg: DiscordMessage, deps: CommandDeps): Promise<void> {
  const parts = msg.content.trim().split(/\s+/)
  const jobName = parts[1] ?? ''

  if (!jobName) {
    await msg.reply('Usage: `!run <job-name>` — provide a job name to run.')
    return
  }

  const jobCfg = deps.config.agents?.[jobName]
  if (!jobCfg) {
    const available = Object.keys(deps.config.agents ?? {})
    const list = available.length > 0
      ? `Available jobs: ${available.map((n) => `\`${n}\``).join(', ')}`
      : 'No jobs configured.'
    await msg.reply(`Unknown job \`${jobName}\`. ${list}`)
    return
  }

  // JOB-01: Reply immediately so the user knows the job started
  await msg.reply(`Starting job \`${jobName}\`... I'll post the result when it's done.`)

  // Build a minimal RunJobContext from the deps we have.
  // mcpManager is optional — when absent, run-job skips MCP lifecycle.
  const ctx = {
    home: homedir(),
    kcConfig: deps.config,
    provider: deps.provider,
    registry: deps.registry,
    mcpManager: deps.mcpManager,
  }

  // Fire-and-forget: spawn the job without blocking the command handler.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  void (async () => {
    let result: RunJobResult
    try {
      result = await runJob(jobName, jobCfg, ctx)
    } catch (err) {
      // Construct a synthetic error result so onJobComplete always receives
      // a RunJobResult-shaped object, even on catastrophic failure.
      const error = err instanceof Error ? err : new Error(String(err))
      const errorResult: RunJobResult = {
        exitReason: 'max_iterations', // closest available sentinel for "crashed"
        turnCount: 0,
        durationMs: 0,
        error,
        runDir: '',
        runDirName: '',
        parentDir: '',
        logPath: '',
        resultPath: '',
        usagePath: '',
        configPath: '',
      }
      await safeCallback(deps.onJobComplete, msg.channelId, jobName, errorResult)
      return
    }
    await safeCallback(deps.onJobComplete, msg.channelId, jobName, result)
  })()
}

async function safeCallback(
  fn: CommandDeps['onJobComplete'],
  channelId: string,
  jobName: string,
  result: RunJobResult,
): Promise<void> {
  try {
    await fn(channelId, jobName, result)
  } catch (err) {
    log('error', { module: 'discord-commands', source: 'discord', jobName, discordChannelId: channelId, error: err instanceof Error ? err.message : String(err) }, 'onJobComplete error')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// !status implementation
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus(msg: DiscordMessage, deps: CommandDeps): Promise<void> {
  const parts = msg.content.trim().split(/\s+/)
  const jobName = parts[1] || undefined
  const limit = jobName ? 5 : 10

  const rows = await loadStatusRows({ jobName, limit })

  if (rows.length === 0) {
    await msg.reply(jobName ? `No runs found for \`${jobName}\`.` : 'No agent runs found.')
    return
  }

  // Format rows into a Discord-friendly codeblock-style list.
  // Each row: **job** | started | duration | exitReason
  const lines = rows.map((row) => {
    const started = formatStarted(row.startedAt)
    const duration = formatDuration(row.durationMs)
    return `**${row.job}** | ${started} | ${duration} | ${row.exitReason}`
  })

  const header = jobName
    ? `Status for \`${jobName}\` (last ${rows.length} run${rows.length === 1 ? '' : 's'}):`
    : `Recent runs (last ${rows.length}):`

  await msg.reply(`${header}\n${lines.join('\n')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// !usage implementation
// ─────────────────────────────────────────────────────────────────────────────

async function handleUsage(msg: DiscordMessage, deps: CommandDeps): Promise<void> {
  const { loadUsageRecords } = await import('./usage-store.js')
  const { aggregateUsage, formatDiscordUsage } = await import('./usage-format.js')

  // Load today's records only (D-06: !usage shows today's data)
  const now = new Date()
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))

  const records = await loadUsageRecords(startOfDay, endOfDay)

  if (records.length === 0) {
    await msg.reply('No usage recorded today.')
    return
  }

  const pricing = deps.config.discord?.pricing
  const model = deps.config.model
  const text = formatDiscordUsage(records, pricing, model)
  await msg.reply(text)
}

// ─────────────────────────────────────────────────────────────────────────────
// !index implementation (v3.1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Triggers a project index scan or reports current index status. The index is
// scoped to the bot's CWD (typically the kc repo on the machine where the bot
// runs). Watch mode is deliberately omitted — it's long-running and belongs to
// launchd/systemd, not an interactive Discord command.

async function handleIndex(msg: DiscordMessage): Promise<void> {
  const content = msg.content.trim()
  const parts = content.split(/\s+/)
  const sub = parts[1] ?? 'scan'

  if (sub === 'help') {
    await msg.reply(
      '**Index commands**\n' +
        '`!index` or `!index scan` — scan project and update index\n' +
        '`!index status` — show index stats (file count, age, staleness)',
    )
    return
  }

  if (sub !== 'scan' && sub !== 'status') {
    await msg.reply(`Unknown subcommand: \`${sub}\`. Try \`!index help\`.`)
    return
  }

  await msg.reply(`Running \`tm index ${sub === 'scan' ? '' : 'status'}\`...`)

  try {
    const { spawn } = await import('node:child_process')
    const cwd = process.cwd()
    const args = sub === 'scan' ? ['index'] : ['index', 'status']
    const child = spawn('tm', args, { cwd, env: process.env })

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => errChunks.push(d))

    await new Promise<void>((resolve) => {
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })

    const stdout = Buffer.concat(chunks).toString('utf8').trim()
    const stderr = Buffer.concat(errChunks).toString('utf8').trim()
    const output = stdout || stderr || '(no output)'

    // Discord 2000-char limit — truncate
    const truncated = output.length > 1800 ? output.slice(0, 1800) + '\n…(truncated)' : output
    await msg.reply(`\`\`\`\n${truncated}\n\`\`\``)
  } catch (err) {
    await msg.reply(`Failed to run \`tm index\`: ${(err as Error).message}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// !jobs implementation
// ─────────────────────────────────────────────────────────────────────────────

async function handleJobs(msg: DiscordMessage, deps: CommandDeps): Promise<void> {
  const agents = deps.config.agents ?? {}
  const names = Object.keys(agents)

  if (names.length === 0) {
    await msg.reply('No agents configured.')
    return
  }

  const basePath = `${homedir()}/.telemachus/agent-runs`
  const lines: string[] = []

  for (const name of names) {
    const agent = agents[name]!
    const label = `com.telemachus.agent.${name}`

    // Query launchd for running status
    let statusStr: string
    try {
      const proc = Bun.spawn(['launchctl', 'list', label], { stdout: 'pipe', stderr: 'pipe' })
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      const pid = out.match(/"PID"\s*=\s*(\d+)/)?.[1]
      const exitCode = out.match(/"LastExitStatus"\s*=\s*(\d+)/)?.[1]
      if (pid) {
        statusStr = `🟢 running (PID ${pid})`
      } else if (exitCode === '0') {
        statusStr = `✅ idle`
      } else if (exitCode !== undefined) {
        statusStr = `⚠️ idle (last exit ${exitCode})`
      } else {
        statusStr = `✅ idle`
      }
    } catch {
      statusStr = `❓ not loaded`
    }

    // Last run from artifacts
    let lastRunStr = 'never run'
    try {
      const rows = await loadStatusRows({ jobName: name, limit: 1 }, basePath)
      if (rows[0]) {
        const r = rows[0]
        const ageMs = Date.now() - new Date(r.startedAt).getTime()
        const ageMins = Math.floor(ageMs / 60_000)
        const ageStr =
          ageMins < 60
            ? `${ageMins}m ago`
            : ageMins < 1440
              ? `${Math.floor(ageMins / 60)}h ago`
              : `${Math.floor(ageMins / 1440)}d ago`
        const exit = r.exitReason ? ` — ${r.exitReason}` : ''
        lastRunStr = `${ageStr}${exit}`
      }
    } catch {
      // ignore
    }

    const schedule = agent.schedule
      ? agent.schedule.replace(/^cron:\s*/, '')
      : 'on-demand'

    lines.push(`\`${name}\`  ${statusStr}\nSchedule: \`${schedule}\` · Last: ${lastRunStr}`)
  }

  await msg.reply(`**Jobs (${names.length})**\n\n${lines.join('\n\n')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 63 (OBS-05): !tool-errors implementation
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ERROR_WINDOWS: Record<string, { ms: number; label: string }> = {
  '15m': { ms: 15 * 60_000, label: '15m' },
  '1h': { ms: 60 * 60_000, label: '1h' },
  '24h': { ms: 24 * 60 * 60_000, label: '24h' },
}

async function handleToolErrors(msg: DiscordMessage): Promise<void> {
  const { getRecentErrors } = await import('../security/tool-error-metrics.js')
  const { formatToolErrorSection } = await import('./tool-error-format.js')

  const parts = msg.content.trim().split(/\s+/)
  const raw = parts[1]
  let window = TOOL_ERROR_WINDOWS['15m']!
  let windowHint = ''
  if (raw !== undefined && raw !== '') {
    const match = TOOL_ERROR_WINDOWS[raw]
    if (match !== undefined) {
      window = match
    } else {
      windowHint = `Unsupported window \`${raw}\` — supported: 15m, 1h, 24h. Showing default 15m.\n\n`
    }
  }

  const samples = getRecentErrors(window.ms, 100)
  const section = formatToolErrorSection(samples, window.label)
  await msg.reply(`${windowHint}${section}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// !model implementation
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PRESETS: Record<string, { provider: string; model: string; label: string }> = {
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  glm: { provider: 'openai-compat', model: 'glm-5.1', label: 'GLM-5.1' },
  deepseek: { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3' },
}

async function handleModel(msg: DiscordMessage): Promise<void> {
  const parts = msg.content.trim().split(/\s+/)
  const arg = parts[1]?.toLowerCase()

  const modelStatePath = join(homedir(), '.telemachus', 'discord-model-state.json')

  if (!arg || arg === 'status') {
    let current = 'default (glm-5.1)'
    if (existsSync(modelStatePath)) {
      try {
        const state = JSON.parse(readFileSync(modelStatePath, 'utf-8')) as { model?: string; provider?: string }
        if (state.model) current = `${state.model} via ${state.provider}`
      } catch { /* ignore */ }
    }
    const opts = Object.entries(MODEL_PRESETS).map(([k, v]) => `\`!model ${k}\` (${v.label})`).join(', ')
    await msg.reply(`Current model: **${current}**\nAvailable: ${opts}`)
    return
  }

  const preset = MODEL_PRESETS[arg]
  if (!preset) {
    const available = Object.keys(MODEL_PRESETS).map((k) => `\`${k}\``).join(', ')
    await msg.reply(`Unknown model \`${arg}\`. Available: ${available}`)
    return
  }

  writeFileSync(modelStatePath, JSON.stringify({ provider: preset.provider, model: preset.model }, null, 2))
  // TRAJ-02: manual model override = dissatisfaction signal
  void import('../shared/trajectory.js').then(({ appendSignal }) =>
    appendSignal({
      ts: new Date().toISOString(),
      transport: 'discord',
      type: 'manual_override',
      model: preset.model,
    })
  )
  await msg.reply(`Switching to **${preset.label}** — restarting now... 🔄`)

  setTimeout(() => {
    const uid = process.getuid?.() ?? 501
    Bun.spawn(['launchctl', 'kickstart', '-k', `gui/${uid}/com.telemachus.discord`], {
      stdout: 'ignore', stderr: 'ignore',
    })
  }, 1500)
}
