/**
 * Phase 22-03 (AGENT-01 / AGENT-03): `tm agent` subcommand dispatcher.
 *
 * This is the external CLI contract for headless agent jobs. src/index.ts
 * branches here BEFORE the interactive TTY guard, so `tm agent run <name>`
 * never touches Ink, the session store, or the resume picker.
 *
 * Every terminal branch calls `process.exit(code)` directly so callers
 * can't accidentally continue into the interactive startup path.
 */
import { homedir } from 'node:os'
import * as path from 'node:path'
import { loadConfig } from '../config/loader.js'
import { buildAllTools } from '../tools/builtin/index.js'
import { maybeLoadIndexClient } from '../project-index/maybe-load.js'
import { createProvider } from '../providers/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import {
  resolveActiveProfile,
  filterMcpServersByProfile,
  filterCliToolsByProfile,
} from '../config/profile.js'
import { McpManager } from '../mcp/manager.js'
import { runJob } from './run-job.js'
import { printAgentHelp } from './help.js'
import { runStatusCommand } from './status.js'
import {
  install,
  uninstall,
  list,
  formatListTable,
  type InstallPaths,
} from './launchd-install.js'
import { realRunner } from './launchctl.js'

function defaultInstallPaths(): InstallPaths {
  const home = homedir()
  return {
    launchAgentsDir: path.join(home, 'Library', 'LaunchAgents'),
    homedir: home,
  }
}

export async function runAgentSubcommand(argv: string[]): Promise<void> {
  const sub = argv[0]

  // ————— help branches —————
  if (sub === undefined || sub === '--help' || sub === '-h') {
    printAgentHelp()
    process.exit(0)
  }

  // ————— status (Phase 23-03 / AGENT-06) —————
  if (sub === 'status') {
    const code = await runStatusCommand(argv.slice(1))
    process.exit(code)
  }

  // ————— install (Phase 24-02 / AGENT-07) —————
  if (sub === 'install') {
    const name = argv[1]
    if (!name) {
      process.stderr.write('Error: tm agent install requires a job name\n\n')
      printAgentHelp()
      process.exit(1)
    }
    const config = await loadConfig(process.cwd())
    const jobCfg = config.agents?.[name]
    if (!jobCfg) {
      const available = Object.keys(config.agents ?? {})
      const suggestion =
        available.length > 0 ? ` (configured: ${available.join(', ')})` : ''
      process.stderr.write(
        `Error: no agent job named '${name}' in config.agents${suggestion}\n`,
      )
      process.exit(1)
    }
    try {
      const result = await install(name, jobCfg, realRunner, defaultInstallPaths())
      process.stdout.write(`${result.action}: ${result.plistPath}\n`)
      process.exit(0)
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(2)
    }
  }

  // ————— uninstall (Phase 24-02 / AGENT-07) —————
  if (sub === 'uninstall') {
    const name = argv[1]
    if (!name) {
      process.stderr.write('Error: tm agent uninstall requires a job name\n\n')
      printAgentHelp()
      process.exit(1)
    }
    try {
      const result = await uninstall(name, realRunner, defaultInstallPaths())
      process.stdout.write(`${result.action}: com.telemachus.agent.${name}\n`)
      process.exit(0)
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(2)
    }
  }

  // ————— list (Phase 24-02 / AGENT-07) —————
  if (sub === 'list') {
    try {
      const config = await loadConfig(process.cwd())
      const rows = await list(config, realRunner, defaultInstallPaths())
      process.stdout.write(formatListTable(rows))
      process.exit(0)
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(2)
    }
  }

  // ————— run —————
  if (sub === 'run') {
    const jobName = argv[1]
    if (!jobName) {
      process.stderr.write('Error: tm agent run requires a job name\n\n')
      printAgentHelp()
      process.exit(1)
    }

    const originalConfig = await loadConfig(process.cwd())
    const jobCfg = originalConfig.agents?.[jobName]
    if (!jobCfg) {
      const available = Object.keys(originalConfig.agents ?? {})
      const suggestion =
        available.length > 0 ? ` (configured: ${available.join(', ')})` : ''
      process.stderr.write(
        `Error: no agent job named '${jobName}' in config.agents${suggestion}\n`,
      )
      process.exit(1)
    }

    // Phase 23 (AGENT-04): resolve profile + filter BOTH mcpServers and
    // cliTools BEFORE constructing the tool registry. Order is fixed:
    // resolve profile → filter mcpServers → filter cliTools → buildAllTools.
    let activeProfileName: string | undefined
    try {
      activeProfileName = resolveActiveProfile(originalConfig, jobCfg.profile, undefined)
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    }
    const filteredMcpServers = filterMcpServersByProfile(originalConfig, activeProfileName)
    const filteredCliTools = filterCliToolsByProfile(originalConfig, activeProfileName)
    const kcConfig = {
      ...originalConfig,
      mcpServers: filteredMcpServers,
      cliTools: filteredCliTools,
      // ROUTE-04: per-job provider/model override top-level config.
      // Only applied when the job explicitly sets the field.
      ...(jobCfg.provider !== undefined && { provider: jobCfg.provider }),
      ...(jobCfg.model !== undefined && { model: jobCfg.model }),
    }

    const provider = createProvider(kcConfig)
    // v3.1 Phase 51: pass optional IndexClient for index-aware glob/grep.
    const loadedIndex = await maybeLoadIndexClient()
    const registry = new ToolRegistry()
    registry.registerAll(buildAllTools(kcConfig, loadedIndex?.client ?? null))

    // Phase 24 dogfood fix: headless agent runs must spawn configured MCP
    // servers too, not just builtins + CLI tools. Without this the model's
    // tool manifest is empty of MCP tools — the profile filter had nothing
    // to filter. Mirrors what src/index.ts does for interactive mode.
    const sessionId = `agent-${jobName}-${Date.now()}`
    const mcpManager = new McpManager({
      config: kcConfig,
      registry,
      sessionId,
      mode: jobCfg.permissionMode ?? 'agent',
    })

    const home = process.env.HOME ?? homedir()

    let runDir: string
    try {
      const result = await runJob(jobName, jobCfg, {
        home,
        kcConfig,
        provider,
        registry,
        mcpManager,
      })
      runDir = result.runDir
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Agent run failed: ${msg}\n`)
      await mcpManager.dispose().catch(() => {})
      process.exit(2)
    }
    process.stderr.write(`Run complete: ${runDir}\n`)
    process.exit(0)
  }

  // ————— unknown subcommand —————
  process.stderr.write(`Error: unknown subcommand '${sub}'\n\n`)
  printAgentHelp()
  process.exit(1)
}
