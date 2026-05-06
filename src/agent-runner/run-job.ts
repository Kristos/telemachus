/**
 * Phase 22 Wave 2 (AGENT-01 / AGENT-02): runJob orchestrator.
 *
 * Assembles the headless runner from its primitives:
 *   1. prepareRunDir + writeConfig (persist intent BEFORE anything runs)
 *   2. startLogTee (capture stdout/stderr for the whole run)
 *   3. McpManager.loadEager() with signal handlers → dispose in finally
 *   4. buildParentFromConfig → runSubagent (reused unchanged from Phase 13)
 *   5. writeResult + writeUsage + updateLatestSymlink
 *   6. finally: stopLogTee, dispose MCP if not already disposed
 *
 * Everything is injected by the caller so tests can drive the full pipeline
 * with a stub provider, a temp HOME, and (optionally) a stub McpManager.
 * The Wave 3 CLI (`tm agent run <name>`) will import runJob and supply
 * real provider/registry/mcpManager.
 */
import type { Provider } from '../providers/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { KristosConfig } from '../config/types.js'
import type { AgentJobConfig } from './config-schema.js'
import type { ExitReason } from './caps.js'
import { runSubagent } from '../agent/subagent.js'
import { probeSandbox } from '../security/sandbox-probe.js'
import { initSandboxEnv } from '../discord/sandbox-env.js'
import { buildParentFromConfig } from './build-parent.js'
import { loadSharedContext } from '../context/loader.js'
import {
  prepareRunDir,
  writeResult,
  writeUsage,
  writeConfig,
  updateLatestSymlink,
  type ArtifactPaths,
} from './artifacts.js'
import { startLogTee, type LogTeeHandle } from './log-tee.js'
import { pushWebhook, emitWebhookOutput, type WebhookContext } from './output-webhook.js'

/** Minimal McpManager surface runJob needs. Kept as an interface so tests can
 *  supply a stub without constructing a real manager. */
export interface RunJobMcpManager {
  loadEager(): Promise<{ eagerCount: number; lazyCount: number }>
  dispose(): Promise<void>
}

export interface RunJobContext {
  home: string
  kcConfig: KristosConfig
  provider: Provider
  registry: ToolRegistry
  /**
   * Optional MCP manager. When present, `loadEager` is called before the
   * agent loop and `dispose` is called in the finally block. When absent,
   * MCP lifecycle is skipped (e.g. tests that don't care about MCP).
   */
  mcpManager?: RunJobMcpManager
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date
  /**
   * Injectable webhook pusher for tests. Defaults to the real `pushWebhook`
   * from `./output-webhook.js`. Tests can provide a stub to avoid touching
   * global fetch.
   */
  pushWebhookImpl?: typeof pushWebhook
}

export interface RunJobResult extends ArtifactPaths {
  exitReason: ExitReason
  turnCount: number
  durationMs: number
  error: Error | null
}

export async function runJob(
  jobName: string,
  jobCfg: AgentJobConfig,
  ctx: RunJobContext,
): Promise<RunJobResult> {
  const now = ctx.now ?? (() => new Date())
  const nowIso = now().toISOString()
  const paths = await prepareRunDir(ctx.home, jobName, nowIso)

  // Persist effective config FIRST so a crash still leaves a trace of
  // what was attempted.
  await writeConfig(paths.runDir, jobCfg)

  let tee: LogTeeHandle | null = null
  let mcpDisposed = false
  const disposeMcp = async (): Promise<void> => {
    if (mcpDisposed || !ctx.mcpManager) return
    mcpDisposed = true
    try {
      await ctx.mcpManager.dispose()
    } catch (err) {
      process.stderr.write(
        `[agent-runner] mcp dispose error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  // Signal handlers: if the process is killed mid-run, best-effort dispose
  // MCP children so we don't leak spawned subprocesses. Registered once
  // per run; removed in finally.
  const signalHandler = (): void => {
    void disposeMcp()
  }
  process.once('SIGINT', signalHandler)
  process.once('SIGTERM', signalHandler)

  const startedAt = Date.now()
  let exitReason: ExitReason = 'natural'
  let resultText = ''
  let error: Error | null = null
  let turnCount = 0

  try {
    tee = startLogTee(paths.logPath)

    if (ctx.mcpManager) {
      const counts = await ctx.mcpManager.loadEager()
      // Single concise stderr line per run so operators can see MCP health
      // in log.txt without reading through debug spam.
      process.stderr.write(
        `[mcp] loaded: ${counts.eagerCount} eager, ${counts.lazyCount} lazy\n`,
      )
    }

    const sessionId = `agent-${jobName}-${paths.runDirName}`

    // Post-v3.8 hotfix: launchd spawns agent-runner with cwd='/' (same root
    // cause as the Discord fix in 56e43ae/a9e557a). Seed HOME + KC_PROJECT_ROOT
    // and chdir to project root BEFORE the probe. Idempotent; name of the
    // helper is Discord-legacy but the logic is generic.
    initSandboxEnv()

    // Phase 62 (SAND-02): defensive pre-spawn probe. runSubagent also probes
    // internally, but failing here gives the headless run artifacts a clean
    // record (writeResult/writeUsage in the finally block capture the error).
    const probe = probeSandbox({ sessionId })
    if (!probe.pass) {
      throw new Error(
        `agent-runner sandbox_probe failed: ${probe.reason ?? 'unknown'} (home='${probe.home}', cwd='${probe.cwd}'). See SAND-02 / BACKLOG 999.15.`,
      )
    }

    const { parent } = buildParentFromConfig(jobCfg, ctx.kcConfig, {
      provider: ctx.provider,
      registry: ctx.registry,
      sessionId,
    })

    // Phase 67 (AGMEM-03): thread jobName as agentName so per-agent memory
    // from ~/.telemachus/agent-memory/<jobName>/MEMORY.md is loaded. Also
    // closes a latent gap: prior to this, headless agents ran with no system
    // prompt at all (no CLAUDE.md / KC_MEMORY.md either). Wrapped in try/catch
    // because context load failure must never kill a scheduled agent run —
    // matches the file's established "stderr + continue" error model.
    let sharedSystemPrompt: string | undefined
    try {
      const sharedCtx = await loadSharedContext({
        homedir: ctx.home,
        tokenBudget: ctx.kcConfig.contextTokenBudget,
        agentName: jobName,
      })
      sharedSystemPrompt = sharedCtx.systemPromptPrefix || undefined
    } catch (err) {
      process.stderr.write(
        `[agent-runner] context load failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }

    const subResult = await runSubagent(
      parent,
      jobCfg.prompt,
      {
        maxIterations: jobCfg.maxIterations ?? 20,
        maxWallClockMs: jobCfg.maxWallClockMs ?? 600_000,
        maxTotalTokens: jobCfg.maxTotalTokens ?? 100_000,
        onExit: (reason: ExitReason) => {
          exitReason = reason
        },
        ...(sharedSystemPrompt !== undefined && { systemPrompt: sharedSystemPrompt }),
      },
    )

    resultText = subResult.text
    error = subResult.error
    turnCount = subResult.messages.filter((m) => m.role === 'assistant').length
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err))
  } finally {
    const durationMs = Date.now() - startedAt

    // Write result + usage even if runSubagent crashed — give operators
    // a partial artifact rather than nothing.
    try {
      await writeResult(paths.runDir, resultText)
    } catch {}
    try {
      await writeUsage(paths.runDir, {
        turn_count: turnCount,
        duration_ms: durationMs,
        exit_reason: exitReason,
        error: error?.message ?? null,
      })
    } catch {}
    try {
      await updateLatestSymlink(paths.parentDir, paths.runDirName)
    } catch {}

    if (tee) tee.stop()
    await disposeMcp()

    process.off('SIGINT', signalHandler)
    process.off('SIGTERM', signalHandler)
  }

  // Output channel: best-effort webhook delivery (AGENT-05).
  // Runs AFTER the finally block so artifacts + log tee are already flushed.
  // emitWebhookOutput never throws — failures are recorded in webhook.json +
  // log.txt but never affect the run's exit status. When output is absent or
  // output.type === 'file', NO network call happens.
  if (jobCfg.output && jobCfg.output.type === 'webhook') {
    const pusher = ctx.pushWebhookImpl ?? pushWebhook
    const webhookCtx: WebhookContext = {
      exitReason,
      error: error?.message ?? null,
      ok: exitReason === 'natural' && error === null,
    }
    await emitWebhookOutput(jobCfg.output, paths, jobName, webhookCtx, pusher, now)
  }

  return {
    ...paths,
    exitReason,
    turnCount,
    durationMs: Date.now() - startedAt,
    error,
  }
}
