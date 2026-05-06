#!/usr/bin/env bun
import React from 'react'
import { render } from 'ink'
import { parseArgs } from 'util'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, realpathSync } from 'node:fs'
import { App } from './ui/app.js'
import { loadHooks } from './hooks/index.js'
import { loadConfig } from './config/loader.js'
import { getOllamaToolWarning } from './config/ollama-warning.js'
import { createProvider } from './providers/registry.js'
import { ToolRegistry } from './tools/registry.js'
import { buildAllTools } from './tools/builtin/index.js'
import { maybeLoadIndexClient } from './project-index/maybe-load.js'
import { loadSkills } from './skills/loader.js'
import { McpManager } from './mcp/manager.js'
import { checkSchemaBudget, formatBudgetWarning } from './mcp/schema-budget.js'
import { resolveActiveProfile, filterMcpServersByProfile, filterCliToolsByProfile, resolveEffectiveProvider } from './config/profile.js'
import { initSession, loadSession } from './session/store.js'
import { loadSessionSummaries, SessionPicker } from './session/resume.js'
import { resolveMode } from './permissions/enforcer.js'
import { detectSandboxExec } from './tools/sandbox/macos.js'
import type { MsgEntry, MetaEntry, UsageEntry } from './session/types.js'
import type { Message } from './providers/types.js'

const BANNER = `
\x1b[38;5;58m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;58m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;94m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠻⡝⡞⡪⣂⠀⢊⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;94m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⢈⠠⠀⠈⠢⠐⠈⠠⠀⠀⠢⡳⡻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;130m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢁⠐⠠⠁⣈⠐⡠⢂⡐⠄⠈⠨⠐⡩⣺⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⠿⣟⣟⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;130m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄⣤⣇⢈⠒⡌⠆⡒⡘⢅⠢⠀⠨⠪⡕⣽⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⠿⡻⡫⣫⣣⣷⣾⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;172m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣱⠠⣡⡲⡾⣾⣶⢵⡨⠢⠀⠀⢈⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⠿⠻⣛⣙⣭⣬⣶⣵⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;172m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣪⢪⠹⡱⡫⣟⡿⣻⢽⣪⢊⡊⠠⡀⠹⡿⡿⠻⡛⠫⠩⣋⣕⣥⣦⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;208m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢗⠝⡽⢱⢪⠌⡔⠁⢊⠪⢘⠐⡪⠀⢉⠪⡪⡪⡴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;208m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣟⠔⠈⢈⠂⢅⠕⡀⢌⠀⠄⠀⣼⠂⠀⠄⠨⣢⣳⢹⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;214m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⠛⠫⢋⢑⠡⣐⡅⡮⡢⢃⠝⡀⠐⠨⢘⠺⢊⠀⠀⢁⠈⡚⠜⡐⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;214m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⡟⣟⢟⢽⠥⣅⢤⣦⣶⣷⣿⣿⡢⢐⢼⢜⢕⠌⠄⠐⠀⠀⠀⠀⠀⠄⠠⠀⠀⠄⠀⠂⡐⢨⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;220m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⢛⠛⠩⣉⣐⡠⡪⢎⢎⢪⠪⢊⢲⢱⢣⡫⣛⢿⣿⢡⢢⢏⢞⠨⡐⢈⢀⠄⢄⢢⡠⡑⡁⠀⠠⠀⡀⠁⠄⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;220m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⡿⡿⠿⢛⠛⠙⡉⣈⣄⣬⣶⣶⣿⣿⣿⠫⠨⡨⣢⣳⣾⣾⢦⣣⡑⡕⡝⡜⡪⣪⡘⡘⢌⣴⣽⠱⡰⡱⣸⣵⣿⣿⡗⣮⣆⢄⠀⠀⠀⠠⠐⢨⣉⡻⡻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;222m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⢿⠿⠿⡿⡿⠿⠻⢛⣍⣍⣤⣴⣴⣶⣾⣿⣿⣿⣿⣿⣿⣿⣿⠅⡥⣕⣿⡿⣿⣻⣻⣻⡽⡷⣵⡱⡱⡸⡜⣵⡪⡻⡿⠇⠕⡘⠌⠋⠠⠈⠍⠘⠿⣿⣿⡷⣅⠄⠀⠂⢦⣉⣿⣿⣷⣷⣽⡿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;222m  ⣿⣿⣿⣿⣿⡿⢟⡫⠭⢖⢓⠫⠩⢀⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⡃⣮⢿⡏⢯⡺⣪⢺⡪⣫⢯⡺⡯⣷⣱⢱⢑⠜⡕⢥⠁⠂⠀⢂⠡⠁⡁⠂⡁⢀⠈⠛⡿⣗⢯⢦⡈⠖⢽⣾⣿⣿⣿⣿⣿⣿⣽⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;214m  ⣿⡿⣟⣫⣑⣌⣴⣤⣵⣴⣶⣶⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠠⢘⡾⣗⠕⡝⡜⡜⢜⢜⡜⡵⣫⢯⡳⡯⣗⢆⡑⢜⢔⢕⠄⠈⠀⡀⠂⡀⠂⠠⠀⡂⠀⠌⠱⡃⠈⠟⣈⠐⡽⣿⣿⣿⣿⡿⣿⢿⡿⣿⢿⢿⠿⠿⠿⢟⠟⡟⡟⢟⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;208m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡧⠀⡵⡹⡐⢵⠨⢣⠡⠣⡣⡣⢫⠢⡣⢳⢹⠸⣫⢮⠢⣑⢌⠞⡄⢀⢠⢀⠀⣂⣀⠐⢌⠊⡊⢊⠊⠊⠘⠈⠀⡉⢈⠠⠐⠀⠨⠀⠅⠨⠐⢀⠂⡈⠄⡁⡢⣀⢣⢢⢆⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;172m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠡⡹⡌⢎⠮⡱⢐⠌⢜⢌⠪⡊⢎⠢⢑⢑⡑⡸⢝⢎⢂⢅⢑⠨⡀⠌⠐⡀⠐⠈⡀⠅⠠⠠⠠⠈⡀⢐⣈⡀⢤⣤⣤⣦⣦⣧⣾⣾⣾⣾⣶⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m
\x1b[38;5;130m  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⢇⠪⢰⢱⢘⢐⠌⡈⡂⠅⢕⢑⢌⢂⠂⢜⡘⢎⢎⢊⢆⢐⢈⠐⡸⣆⢀⠂⠄⠀⠡⠁⠈⠠⠀⠀⠘⡎⣗⠄⡘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿\x1b[0m

\x1b[38;5;94m      ██╗  ██╗██████╗ ██╗███████╗████████╗ ██████╗ ███████╗      ██████╗██╗       █████╗ ██╗    ██╗\x1b[0m
\x1b[38;5;130m      ██║ ██╔╝██╔══██╗██║██╔════╝╚══██╔══╝██╔═══██╗██╔════╝     ██╔════╝██║      ██╔══██╗██║    ██║\x1b[0m
\x1b[38;5;172m      █████╔╝ ██████╔╝██║███████╗   ██║   ██║   ██║███████╗     ██║     ██║      ███████║██║ █╗ ██║\x1b[0m
\x1b[38;5;208m      ██╔═██╗ ██╔══██╗██║╚════██║   ██║   ██║   ██║╚════██║     ██║     ██║      ██╔══██║██║███╗██║\x1b[0m
\x1b[38;5;214m      ██║  ██╗██║  ██║██║███████║   ██║   ╚██████╔╝███████║     ╚██████╗███████╗██║  ██║╚███╔███╔╝\x1b[0m
\x1b[38;5;220m      ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚══════╝      ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝\x1b[0m
\x1b[2m                              ΜΟΛΩΝ ΛΑΒΕ · personal coding agent · v1.8\x1b[0m

\x1b[2m  Tips:\x1b[0m \x1b[38;5;214m/model\x1b[0m\x1b[2m switch model  ·  \x1b[0m\x1b[38;5;214m/help\x1b[0m\x1b[2m list commands  ·  \x1b[0m\x1b[38;5;214m/cost\x1b[0m\x1b[2m usage  ·  config at \x1b[0m\x1b[38;5;214m~/.telemachus/config.json\x1b[0m
`

async function main() {
  // Global --help: list all subcommands
  if (process.argv[2] === '--help' || process.argv[2] === '-h' || process.argv[2] === 'help') {
    process.stdout.write(`Telemachus — Personal AI coding agent

Usage: tm [subcommand] [options]

Subcommands:
  (none)                          Interactive TUI session
  agent run <name>                Run a headless agent job
  agent status [name]             Show run history
  agent install <name>            Install launchd schedule
  agent uninstall <name>          Remove launchd schedule
  agent list                      List installed agent jobs
  discord                         Start Discord bot
  discord install                 Install Discord bot as launchd service
  discord uninstall               Remove Discord launchd service
  discord usage [--days N]        Show token usage stats
  telegram                        Start Telegram bot
  telegram install                Install Telegram bot as launchd service
  telegram uninstall              Remove Telegram launchd service
  orchestrate <config.json>       Run orchestration from JSON config
  orchestrate --template <name>   Run from project template
  orchestrate --prompt "<text>"   Natural language → auto-decompose → execute
  orchestrate --cheap --prompt    All GLM mode (zero Opus spend)
  deploy --message "<msg>"        Commit + push + open PR (requires approval)
  index                           Scan project and build index
  index watch                     Keep index live with file watcher

Options:
  --help, -h                      Show this help
  --profile <name>                Activate a named profile
  --resume                        Resume last session

Config: ~/.telemachus/config.json
`)
    process.exit(0)
  }

  // Phase 55: --version surfaces the version string + effective semaphore cap.
  if (process.argv[2] === '--version' || process.argv[2] === '-v' || process.argv[2] === 'version') {
    const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json()
    const version = (pkg as Record<string, unknown>).version ?? 'unknown'
    // Load config to surface effective maxInflightLLM cap (success criterion 3).
    const cfg = await loadConfig()
    process.stdout.write(`kc ${version}\n`)
    process.stdout.write(`maxInflightLLM: ${cfg.maxInflightLLMRequests}\n`)
    process.exit(0)
  }

  if (process.argv[2] === 'agent') {
    const { runAgentSubcommand } = await import('./agent-runner/index.js')
    await runAgentSubcommand(process.argv.slice(3))
    return // runAgentSubcommand calls process.exit — this is belt-and-suspenders
  }

  // Phase 30 (SEC-10..12, CFG-01): Discord bot subcommand. Like agent, must
  // run BEFORE the TTY guard — `tm discord` is a long-running headless process.
  if (process.argv[2] === 'discord') {
    const { runDiscordSubcommand } = await import('./discord/index.js')
    await runDiscordSubcommand(process.argv.slice(3))
    return
  }

  // Phase 69 (TGCORE-01..05): Telegram bot subcommand. Headless long-running process.
  if (process.argv[2] === 'telegram') {
    const { runTelegramSubcommand } = await import('./telegram/index.js')
    await runTelegramSubcommand(process.argv.slice(3))
    return
  }

  // Phase 40 (ENTRY-01): Orchestration subcommand. Headless — runs before TTY guard.
  if (process.argv[2] === 'orchestrate') {
    const { runOrchestrateSubcommand } = await import('./orchestration/cli.js')
    await runOrchestrateSubcommand(process.argv.slice(3))
    return
  }

  // `tm deploy` — one-shot approval-gated commit + push + open PR.
  // Runs unsandboxed; approval is the only gate. Headless subcommand.
  if (process.argv[2] === 'deploy') {
    const { runDeploySubcommand } = await import('./deploy/cli.js')
    await runDeploySubcommand(process.argv.slice(3))
    return
  }

  // Phase 47 (IDX-01..05): Project index subcommand. Headless — runs before TTY guard.
  if (process.argv[2] === 'index') {
    const { runIndexSubcommand } = await import('./project-index/cli.js')
    await runIndexSubcommand(process.argv.slice(3))
    return
  }

  // Guard: must be interactive terminal
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: tm requires an interactive terminal\n')
    process.exit(1)
  }

  // Startup banner
  process.stderr.write(BANNER + '\n')

  // Parse CLI flags
  const { values: cliFlags } = parseArgs({
    args: process.argv.slice(2),
    options: {
      session: { type: 'string', short: 's' },
      resume:  { type: 'boolean', short: 'r' },
      mode:    { type: 'string' },
      profile: { type: 'string' },
    },
    strict: false,
  })

  const cwd = process.cwd()
  const originalConfig = await loadConfig(cwd)

  // Phase 19 (LEAN-01): resolve active profile from CLI flag + config, then
  // filter the mcpServers map BEFORE constructing McpManager so excluded
  // servers never reach the LLM tool manifest.
  const cliProfile = cliFlags.profile as string | undefined
  let activeProfileName: string | undefined
  try {
    activeProfileName = resolveActiveProfile(originalConfig, cliProfile, undefined)
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
  const filteredMcpServers = filterMcpServersByProfile(originalConfig, activeProfileName)
  const filteredCliTools = filterCliToolsByProfile(originalConfig, activeProfileName)
  const effective = resolveEffectiveProvider(originalConfig, activeProfileName)
  const config = {
    ...originalConfig,
    mcpServers: filteredMcpServers,
    cliTools: filteredCliTools,
    provider: effective.provider,
    model: effective.model,
  }
  if (activeProfileName) {
    process.stderr.write(`Profile: ${activeProfileName}\n`)
    if (effective.provider !== originalConfig.provider) {
      process.stderr.write(`Provider: ${effective.provider} (profile: ${activeProfileName})\n`)
    }
  }

  const ollamaWarning = getOllamaToolWarning(config)
  if (ollamaWarning) {
    process.stderr.write(`\x1b[2m${ollamaWarning}\x1b[0m\n`)
  }

  const rawCliMode = cliFlags.mode as string | undefined
  const rawEnvMode = process.env.KC_PERMISSION_MODE
  const effectiveMode = resolveMode(config.permissionMode, rawEnvMode, rawCliMode)
  // Warn on invalid --mode value
  if (rawCliMode && !['yolo', 'ask', 'readonly', 'plan'].includes(rawCliMode)) {
    process.stderr.write(`Warning: Unknown mode '${rawCliMode}' — using '${effectiveMode}'\n`)
  }

  const provider = createProvider(config)

  // Build tool registry with builtin tools + configured CLI tools (LEAN-02).
  // buildAllTools() composes allBuiltinTools with any entries from config.cliTools,
  // each registered via registerCliTools() which also wires trust-tier overrides.
  // v3.1 Phase 51: pass optional IndexClient for index-aware glob/grep.
  const loadedIndex = await maybeLoadIndexClient()
  const registry = new ToolRegistry()
  registry.registerAll(buildAllTools(config, loadedIndex?.client ?? null))

  // Load skills
  const skills = await loadSkills()
  if (skills.length > 0) {
    process.stderr.write(`Skills: ${skills.length} loaded\n`)
  }

  // — Determine session ID and initial messages (new vs resume) —
  let sessionId: string
  let initialMessages: Message[] = []

  if (cliFlags.resume) {
    // -r / --resume: interactive picker or auto-resume
    const summaries = await loadSessionSummaries(10)

    if (summaries.length === 0) {
      process.stderr.write('No sessions found.\n')
      process.exit(0)
    }

    let chosen: typeof summaries[0]
    if (summaries.length === 1) {
      // Auto-resume single session — no picker needed
      chosen = summaries[0]
    } else {
      // Render picker, wait for selection
      chosen = await new Promise<typeof summaries[0]>(resolve => {
        const { unmount } = render(
          React.createElement(SessionPicker, {
            summaries,
            onSelect: (s) => { unmount(); resolve(s) },
          })
        )
      })
    }

    sessionId = chosen.id
    const entries = await loadSession(sessionId)
    initialMessages = entries
      .filter((e): e is MsgEntry => e.type === 'msg')
      .map(e => e.message)

    const date = new Date(chosen.startedAt).toLocaleString()
    process.stderr.write(
      `\nResuming session ${sessionId}\n` +
      `  Started: ${date}\n` +
      `  Messages: ${chosen.messageCount}\n` +
      `  Cost: $${chosen.totalCostUsd.toFixed(4)}\n\n`
    )

  } else if (cliFlags.session) {
    // --session {id}: direct resume by ID
    const id = cliFlags.session as string
    let entries: Awaited<ReturnType<typeof loadSession>>
    try {
      entries = await loadSession(id)
    } catch {
      process.stderr.write(`Error: session '${id}' not found in ~/.telemachus/sessions/\n`)
      process.exit(1)
    }

    sessionId = id
    initialMessages = entries
      .filter((e): e is MsgEntry => e.type === 'msg')
      .map(e => e.message)

    const meta = entries.find((e): e is MetaEntry => e.type === 'meta')
    const usageEntries = entries.filter((e): e is UsageEntry => e.type === 'usage')
    const usageEntry = usageEntries.length > 0 ? usageEntries[usageEntries.length - 1] : undefined
    if (meta) {
      const date = new Date(meta.startedAt).toLocaleString()
      process.stderr.write(
        `\nResuming session ${sessionId}\n` +
        `  Started: ${date}\n` +
        `  Messages: ${initialMessages.length}\n` +
        `  Cost: $${(usageEntry?.totalCostUsd ?? 0).toFixed(4)}\n\n`
      )
    }

  } else {
    // Normal new session
    sessionId = randomUUID()
    await initSession(sessionId, {
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      model: config.model,
    })
  }

  // Phase 18-02: McpManager wiring (MCP-01, MCP-02, MCP-03)
  const mcpManager = new McpManager({
    config,
    registry,
    sessionId,
    mode: effectiveMode,
  })
  if (config.mcpServers === undefined) {
    process.stderr.write('MCP: 0 MCP servers loaded (see config)\n')
  } else {
    const { eagerCount, lazyCount } = await mcpManager.loadEager()
    process.stderr.write(`MCP: ${eagerCount} eager, ${lazyCount} lazy MCP servers configured\n`)
  }

  // Phase 19 LEAN-03: schema-budget startup warning. Never blocks startup.
  try {
    const budget = config.mcpDefaults?.schemaBudgetTok ?? 200
    const offenders = checkSchemaBudget(registry.getAll(), budget)
    if (offenders.length > 0) {
      process.stderr.write(formatBudgetWarning(offenders, budget) + '\n')
    }
  } catch {}
  // Graceful shutdown — dispose all MCP children on SIGINT / exit (RESEARCH risk #1)
  const disposeMcp = () => { void mcpManager.dispose() }
  process.on('SIGINT', () => {
    mcpManager.dispose().finally(() => process.exit(0))
  })
  process.on('exit', disposeMcp)

  // Load hooks once per session from ~/.claude.json
  const hooks = await loadHooks()

  // Phase 17: session-scoped tmpdir for sandboxed bash writes. Symlink-resolved
  // so SBPL path rules match what the kernel sees (RESEARCH Pitfall 1).
  let sessionTmpdir: string | undefined
  try {
    sessionTmpdir = `${realpathSync('/tmp')}/kc-${sessionId}`
    mkdirSync(sessionTmpdir, { recursive: true })
  } catch (err) {
    process.stderr.write(
      `[kc] warn: could not create session tmpdir: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    sessionTmpdir = undefined
  }

  // Phase 17: probe sandbox-exec. On non-darwin we don't even try.
  let sandboxAvailable = false
  if (process.platform === 'darwin') {
    sandboxAvailable = await detectSandboxExec()
    if (!sandboxAvailable) {
      process.stderr.write(
        `Warning: sandbox-exec probe failed. Bash tool will be disabled outside yolo mode.\n`,
      )
    }
  } else {
    // SEC-05: one-time session warning on linux/win32 — bash runs unsandboxed
    process.stderr.write(
      `Warning: Telemachus bash tool runs unsandboxed on ${process.platform}. See README Security section.\n`,
    )
  }

  // Cleanup session tmpdir on process exit (best-effort — never throw)
  if (sessionTmpdir) {
    const tmpdirToRemove = sessionTmpdir
    process.on('exit', () => {
      try { rmSync(tmpdirToRemove, { recursive: true, force: true }) } catch {}
    })
  }

  // Render the main App (same for new and resumed sessions)
  const { waitUntilExit } = render(
    React.createElement(App, { initialProvider: provider, registry, config, originalConfig, initialActiveProfile: activeProfileName, cwd, skills, sessionId, initialMessages, permissionMode: effectiveMode, hooks, mcpManager, sessionTmpdir, sandboxAvailable })
  )

  await waitUntilExit()
  process.stderr.write(`\nSession saved. Resume with: tm --session ${sessionId}\n`)
}

main().catch(err => {
  process.stderr.write(
    `\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`
  )
  process.exit(1)
})
