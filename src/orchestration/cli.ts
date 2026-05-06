/**
 * Phase 40-01 (ENTRY-01): `tm orchestrate <config-file>` CLI entry point.
 * Phase 44-02: Extended with --prompt and --cheap flags.
 * Phase 53-03: Extended with runWaveFailFastCliPrompt (3-way CLI readline gate).
 *
 * Loads a JSON orchestration config, validates it with Zod, builds a
 * SubagentParent from the kc config, runs the orchestration engine, and
 * exits with code 0 (all approved) or 1 (any failed/escalated).
 *
 * Design decisions:
 * - onTaskTransition hook streams "[taskId] from -> to\n" to stdout
 * - escalated require_human tasks print a CLI-specific warning to stderr
 *   (no human gate in CLI — use Discord for that)
 * - onEscalated is NOT wired in CLI — tasks escalate without human interaction
 * - --prompt: decomposes NL to OrchestrationRunConfig, gates on plan approval
 * - --cheap: uses GLM for decomposer, all workers, and reviewer
 *
 * Exports: runOrchestrateSubcommand, runWaveFailFastCliPrompt
 */

import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import type { SubagentParent } from '../agent/subagent.js'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/registry.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildAllTools } from '../tools/builtin/index.js'
import { maybeLoadIndexClient } from '../project-index/maybe-load.js'
import { OrchestrationRunConfigSchema, type OrchestrationRunConfig } from './config-schema.js'
import { runOrchestration, type OrchestrationHooks } from './engine.js'
import type { OrchestrationState } from './types.js'
import { getTemplate, instantiateTemplate, listTemplates } from './templates/index.js'
import { decompose } from './decomposer.js'
import { awaitPlanApproval } from './plan-approval.js'
import type { WaveFailFastPrompt, WaveSnapshot } from './wave-fail-fast.js'

// ---------------------------------------------------------------------------
// Phase 53-03: CLI readline 3-way prompt for the wave fail-fast gate
// ---------------------------------------------------------------------------

/**
 * Phase 53: CLI readline-driven 3-way prompt for the wave fail-fast gate.
 * Loops on 'inspect' (prints snapshot.formatInspection() then re-prompts).
 * Returns the engine-facing 'continue' | 'abort' decision.
 *
 * Pure with respect to readLine/print injectables for testability.
 * Production wiring in runOrchestrateWithConfig composes this with the real
 * readline interface.
 */
export async function runWaveFailFastCliPrompt(
  snapshot: WaveSnapshot,
  io: {
    readLine: (prompt: string) => Promise<string>
    print: (text: string) => void
  },
): Promise<'continue' | 'abort'> {
  const failedIds = snapshot.failedTasks.map((f) => f.id).join(', ')
  io.print(
    `\n[wave ${snapshot.waveNumber}] ${snapshot.failedTasks.length}/${snapshot.totalTasks} tasks failed ` +
      `(rate ${snapshot.rate.toFixed(2)} >= threshold ${snapshot.threshold})`,
  )
  io.print(`Failed: ${failedIds}`)

  while (true) {
    const answer = (await io.readLine('Continue / Abort / Inspect? (c/a/i): '))
      .trim()
      .toLowerCase()
    if (answer === 'c' || answer === 'continue') return 'continue'
    if (answer === 'a' || answer === 'abort') return 'abort'
    if (answer === 'i' || answer === 'inspect') {
      io.print(snapshot.formatInspection())
      continue
    }
    io.print('Invalid input. Please type c, a, or i.')
  }
}

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

/**
 * Run the `tm orchestrate <config.json>` subcommand.
 *
 * @param argv - process.argv.slice(3) (i.e. arguments after 'orchestrate')
 */
export async function runOrchestrateSubcommand(
  argv: string[],
  _deps?: {
    readFile?: (path: string, enc: string) => Promise<string>
    decomposeFn?: typeof decompose
    awaitPlanApprovalFn?: typeof awaitPlanApproval
    confirmFn?: () => Promise<boolean>
  },
): Promise<void> {
  const readFileFn = _deps?.readFile ?? (async (p: string, e: string) => readFile(p, e as BufferEncoding) as Promise<string>)
  const decomposeFn = _deps?.decomposeFn ?? decompose
  const awaitPlanApprovalFn = _deps?.awaitPlanApprovalFn ?? awaitPlanApproval

  // -------------------------------------------------------------------------
  // --prompt flag: tm orchestrate --prompt "..." [--cheap]
  // -------------------------------------------------------------------------

  const cheapFlag = argv.includes('--cheap')
  const promptIdx = argv.indexOf('--prompt')
  if (promptIdx !== -1) {
    // Collect prompt: next arg is the prompt string
    const promptStr = argv[promptIdx + 1]
    if (!promptStr) {
      process.stderr.write('Usage: tm orchestrate --prompt "<natural language>"\n')
      process.exit(1)
    }

    // Build parent (same pattern as runOrchestrateWithConfig)
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
        sessionId: `orchestrate-prompt-${Date.now()}`,
        mode: 'agent',
        originalCwd: process.cwd(),
      },
      temperature: kcConfig.temperature,
      windowSize: kcConfig.windowSize,
      maxIterations: 20,
    }

    // Decompose natural language → OrchestrationRunConfig
    let decomposeResult: Awaited<ReturnType<typeof decompose>>
    try {
      decomposeResult = await decomposeFn({
        parent,
        prompt: promptStr,
        modelOverride: cheapFlag ? GLM_MODEL_OVERRIDE : undefined,
      })
    } catch (err) {
      process.stderr.write(
        `Decomposition failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    }

    // CLI approval callbacks
    const displayFn = async (text: string): Promise<void> => {
      process.stdout.write(text + '\n')
    }

    const confirmFn: () => Promise<boolean> = _deps?.confirmFn ?? (() => new Promise<boolean>((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      rl.question('Approve? (y/n): ', (answer) => {
        rl.close()
        const normalized = answer.trim().toLowerCase()
        resolve(normalized === 'y' || normalized === 'yes')
      })
    }))

    const approvalResult = await awaitPlanApprovalFn(decomposeResult, { displayFn, confirmFn })

    if (approvalResult === 'rejected') {
      process.stdout.write('Plan rejected.\n')
      process.exit(0)
    }

    // Apply cheap overrides to all task models if --cheap
    const finalConfig = cheapFlag
      ? applyCheapOverrides(decomposeResult.config)
      : decomposeResult.config

    return runOrchestrateWithConfig(finalConfig)
  }

  // -------------------------------------------------------------------------
  // --template flag: tm orchestrate --template <name>
  // -------------------------------------------------------------------------

  if (argv[0] === '--template') {
    const templateName = argv[1]
    if (!templateName) {
      process.stderr.write('Usage: tm orchestrate --template <name>\n\n')
      process.stderr.write('  Instantiates a project template and runs the orchestration.\n\n')
      process.stderr.write('Available templates:\n')
      for (const t of listTemplates()) {
        process.stderr.write(`  ${t.name} — ${t.description}\n`)
      }
      process.exit(1)
    }

    const def = getTemplate(templateName)
    if (!def) {
      const available = listTemplates().map((t) => t.name).join(', ')
      process.stderr.write(`Unknown template: "${templateName}"\n`)
      process.stderr.write(`Available templates: ${available}\n`)
      process.exit(1)
    }

    let config: OrchestrationRunConfig
    try {
      config = await instantiateTemplate(def)
    } catch (err) {
      process.stderr.write(
        `Template error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    }

    return runOrchestrateWithConfig(config)
  }

  // -------------------------------------------------------------------------
  // Argument validation (config file path)
  // -------------------------------------------------------------------------

  const configPath = argv[0]
  if (!configPath) {
    process.stderr.write('Usage: tm orchestrate <config.json>\n\n')
    process.stderr.write('  Loads an orchestration run config, executes all tasks,\n')
    process.stderr.write('  and exits 0 when all tasks are approved.\n')
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Read config file
  // -------------------------------------------------------------------------

  let rawContent: string
  try {
    rawContent = await readFileFn(configPath, 'utf8')
  } catch (err) {
    process.stderr.write(
      `Error reading config: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Parse and validate config
  // -------------------------------------------------------------------------

  let raw: unknown
  try {
    raw = JSON.parse(rawContent)
  } catch (err) {
    process.stderr.write(
      `Error parsing config JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }

  const parseResult = OrchestrationRunConfigSchema.safeParse(raw)
  if (!parseResult.success) {
    process.stderr.write(`Config validation error:\n${parseResult.error.message}\n`)
    process.exit(1)
  }

  const config: OrchestrationRunConfig = parseResult.data

  return runOrchestrateWithConfig(config)
}

// -------------------------------------------------------------------------
// Shared runner: builds SubagentParent and runs orchestration engine
// -------------------------------------------------------------------------

async function runOrchestrateWithConfig(config: OrchestrationRunConfig): Promise<void> {
  // -------------------------------------------------------------------------
  // Build SubagentParent following discord/index.ts pattern
  // -------------------------------------------------------------------------

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
      sessionId: `orchestrate-${Date.now()}`,
      mode: 'agent',
      originalCwd: process.cwd(),
    },
    temperature: kcConfig.temperature,
    windowSize: kcConfig.windowSize,
    maxIterations: 20,
  }

  // -------------------------------------------------------------------------
  // Run orchestration engine with onTaskTransition hook
  // -------------------------------------------------------------------------

  const hooks: OrchestrationHooks = {
    onTaskTransition: (
      taskId: string,
      from: OrchestrationState,
      to: OrchestrationState,
    ) => {
      process.stdout.write(`[${taskId}] ${from} -> ${to}\n`)
    },
    // onEscalated is NOT wired in CLI — tasks escalate without human interaction
  }

  // Phase 53-03: Wire wave fail-fast prompt unless caller already supplied one
  let effectiveConfig = config
  if (typeof config.waveFailFastPrompt !== 'function') {
    const cliPrompt: WaveFailFastPrompt = (snapshot) =>
      runWaveFailFastCliPrompt(snapshot, {
        readLine: (q) =>
          new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout })
            rl.question(q, (a) => {
              rl.close()
              resolve(a)
            })
          }),
        print: (text) => process.stdout.write(text + '\n'),
      })
    effectiveConfig = { ...config, waveFailFastPrompt: cliPrompt }
  }

  const result = await runOrchestration(effectiveConfig, parent, undefined, hooks)

  // -------------------------------------------------------------------------
  // Check results and exit
  // -------------------------------------------------------------------------

  let hasFailure = false

  for (const taskResult of result.taskResults) {
    if (taskResult.finalState === 'failed' || taskResult.finalState === 'escalated') {
      hasFailure = true

      // Warn for require_human tasks that escalated without a human gate
      if (taskResult.finalState === 'escalated') {
        const taskConfig = config.tasks.find((t) => t.id === taskResult.taskId)
        if (taskConfig?.escalation === 'require_human') {
          process.stderr.write(
            `[${taskResult.taskId}] escalated (require_human tasks cannot be human-gated via CLI)\n`,
          )
        }
      }
    }
  }

  if (hasFailure) {
    process.exit(1)
  }

  process.exit(0)
}
