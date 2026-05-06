/**
 * Phase 44: Decomposer — natural language prompt to OrchestrationRunConfig.
 *
 * Calls Opus (or a model override) via runSubagent with a structured system
 * prompt that includes available templates (TPL-04). The LLM output is
 * expected to be a JSON object matching OrchestrationRunConfigSchema, optionally
 * wrapped in ```json ... ``` fences.
 *
 * Post-processing:
 *  - JSON extraction (fenced or bare)
 *  - dependsOnRationale stripped before Zod validation (display only)
 *  - Zod schema validation
 *  - Unknown dependsOn ID detection
 *  - Cycle detection (reuses detectCycle from queue.ts)
 *  - False linear-chain warning (>60% sequential tasks)
 *
 * DECOMP-01, DECOMP-03, DECOMP-04
 */

import { runSubagent, type SubagentParent } from '../agent/subagent.js'
import { OrchestrationRunConfigSchema } from './config-schema.js'
import type { OrchestrationRunConfig } from './config-schema.js'
import { detectCycle } from './queue.js'
import { getTemplatesForDecomposer } from './templates/index.js'
import type { Provider } from '../providers/types.js'
import {
  renderDependencyWarningsSection,
  validateDependencies,
  type DependencyFlag,
} from './dependency-validator.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DecomposeOptions {
  parent: SubagentParent
  prompt: string
  /** Override model/provider for the decomposer call (e.g. --cheap mode). */
  modelOverride?: { provider: 'anthropic' | 'openai-compat' | 'llamacpp'; model: string }
}

export interface DecomposeResult {
  config: OrchestrationRunConfig
  /** Human-readable numbered task list with dependency annotations. */
  planText: string
  /** Non-fatal warnings, e.g. "Linear chain detected — 4/5 tasks are sequential". */
  warnings: string[]
  /** Phase 52 (DEP-01..03): suspected missing dependency edges flagged by the validator. Empty when validator found nothing or failed (advisory). */
  dependencyFlags: DependencyFlag[]
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object from raw LLM text.
 *
 * Tries a ```json ... ``` fenced block first; falls back to the substring
 * between the first `{` and the last `}`. Returns null on any parse failure.
 */
export function extractJSON(text: string): object | null {
  // 1. Try fenced block: ```json ... ```
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/)
  if (fencedMatch) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim())
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // fall through to bare extraction
    }
  }

  // 2. Fallback: extract from first `{` to last `}`
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1))
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // fall through
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildDecomposerSystemPrompt(userPrompt: string): string {
  const templateContext = getTemplatesForDecomposer()

  return `You are an orchestration planner. Your job is to decompose the user's request into a structured set of parallel tasks that can be executed by a coding agent framework.

${templateContext}

USER REQUEST:
${userPrompt}

OUTPUT REQUIREMENTS:
You MUST respond with ONLY a valid JSON object (no other text) wrapped in \`\`\`json ... \`\`\` fences.

The JSON must match this exact schema:
{
  "schemaVersion": 1,
  "projectDir": "<path where the project should be created, e.g. ~/projects/my-app — REQUIRED for new projects, omit if working in an existing repo>",
  "maxWorkerTurns": <number, default 20>,
  "maxRetries": <number, default 2>,
  "tasks": [
    {
      "id": "<unique-slug>",
      "prompt": "<detailed task instructions>",
      "dependsOn": ["<task-id>", ...],           // ONLY add if task B reads files written by task A, or calls code defined by task A
      "dependsOnRationale": ["<why this dep>", ...], // one rationale per dependsOn entry, same order
      "escalation": "auto_accept" | "require_human"
    }
  ]
}

DEPENDENCY RULES:
- Only add a dependsOn edge if Task B reads files written by Task A, or calls code defined by Task A
- Provide a "dependsOnRationale" array parallel to "dependsOn" — one entry per dependency, explaining exactly WHY the edge exists
- Avoid creating unnecessary sequential chains — prefer parallel tasks when possible
- Tasks that don't share files or exports should run concurrently

Respond with ONLY the JSON object in \`\`\`json ... \`\`\` fences.`
}

// ---------------------------------------------------------------------------
// Plan text builder
// ---------------------------------------------------------------------------

interface RawTask {
  id: string
  prompt: string
  dependsOn?: string[]
  dependsOnRationale?: string[]
  [key: string]: unknown
}

function buildPlanText(tasks: RawTask[], warnings: string[], flags: DependencyFlag[]): string {
  const lines: string[] = [`Proposed Orchestration Plan (${tasks.length} tasks)\n`]

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const promptPreview = task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}...` : task.prompt
    lines.push(`${i + 1}. [${task.id}] ${promptPreview}`)

    if (task.dependsOn && task.dependsOn.length > 0) {
      lines.push(`   Depends on: ${task.dependsOn.join(', ')}`)

      const rationales = task.dependsOnRationale ?? []
      for (let j = 0; j < task.dependsOn.length; j++) {
        const rationale = rationales[j]
        if (rationale) {
          lines.push(`   Rationale: "${rationale}"`)
        }
      }
    }
  }

  const depSection = renderDependencyWarningsSection(flags)
  if (depSection) lines.push(depSection)

  if (warnings.length > 0) {
    lines.push('\nWarnings:')
    for (const w of warnings) {
      lines.push(`  - ${w}`)
    }
  }

  lines.push('\nApprove this plan? (y/n)')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Linear chain detection
// ---------------------------------------------------------------------------

/**
 * Returns a warning string if more than 60% of tasks form a linear chain
 * (each task has exactly one dependsOn pointing to the previous task in order).
 */
function detectLinearChain(tasks: RawTask[]): string | null {
  if (tasks.length <= 1) return null

  let chainLength = 0
  for (let i = 1; i < tasks.length; i++) {
    const task = tasks[i]
    const prev = tasks[i - 1]
    if (
      task.dependsOn?.length === 1 &&
      task.dependsOn[0] === prev.id
    ) {
      chainLength++
    }
  }

  // chainLength counts the edges; the chain spans chainLength+1 tasks (if contiguous)
  // We check if the proportion of "chained" tasks exceeds 60% of all tasks
  const chainedTasks = chainLength + (chainLength > 0 ? 1 : 0)
  if (tasks.length > 0 && chainedTasks / tasks.length > 0.6) {
    return `Linear chain detected — ${chainedTasks}/${tasks.length} tasks are sequential. Consider parallelising independent tasks.`
  }

  return null
}

// ---------------------------------------------------------------------------
// Main decompose function
// ---------------------------------------------------------------------------

/**
 * Decompose a natural language prompt into a validated OrchestrationRunConfig.
 *
 * Calls Opus (or modelOverride) via runSubagent, extracts JSON, validates with
 * Zod, checks deps, detects cycles, and warns on false linear chains.
 */
export async function decompose(options: DecomposeOptions): Promise<DecomposeResult> {
  const { parent, prompt, modelOverride } = options

  const systemPrompt = buildDecomposerSystemPrompt(prompt)

  // Build provider override if a model override is requested
  let providerOverride: Provider | undefined
  if (modelOverride) {
    const { createProvider } = await import('../providers/registry.js')
    const { loadConfig } = await import('../config/loader.js')
    const kcConfig = await loadConfig(process.cwd())
    const overrideConfig = {
      ...kcConfig,
      provider: modelOverride.provider,
      model: modelOverride.model,
    }
    providerOverride = createProvider(overrideConfig)
  }

  const result = await runSubagent(
    parent,
    'Please decompose the request described in the system prompt into a structured task plan.',
    {
      provider: providerOverride,
      systemPrompt,
      maxIterations: 1,
    },
  )

  if (result.error) {
    throw new Error(`Decomposer agent failed: ${result.error.message}`)
  }

  // Extract JSON from LLM output
  const raw = extractJSON(result.text)
  if (!raw) {
    throw new Error('Decomposer did not produce valid JSON')
  }

  // Capture raw tasks (with rationale) before stripping for Zod
  const rawObj = raw as Record<string, unknown>
  const rawTasks: RawTask[] = Array.isArray(rawObj.tasks)
    ? (rawObj.tasks as RawTask[])
    : []

  // Strip dependsOnRationale from each task before Zod validation
  // (it's not part of OrchestrationRunConfigSchema)
  const strippedTasks = rawTasks.map(({ dependsOnRationale: _r, ...rest }) => rest)
  const forValidation = { ...rawObj, tasks: strippedTasks }

  // Validate with Zod
  const parsed = OrchestrationRunConfigSchema.safeParse(forValidation)
  if (!parsed.success) {
    throw new Error(`Decomposer output failed schema validation: ${parsed.error.message}`)
  }

  const config = parsed.data
  const taskIds = new Set(config.tasks.map((t) => t.id))

  // Validate all dependsOn IDs exist in the plan
  for (const task of config.tasks) {
    for (const depId of task.dependsOn ?? []) {
      if (!taskIds.has(depId)) {
        throw new Error(
          `Decomposer referenced unknown task ID "${depId}" in dependsOn for task "${task.id}"`,
        )
      }
    }
  }

  // Cycle detection
  const depMap = new Map<string, string[]>()
  for (const task of config.tasks) {
    depMap.set(task.id, task.dependsOn ?? [])
  }
  const cycleResult = detectCycle(depMap)
  if (cycleResult) {
    throw new Error(`Decomposer produced circular dependencies: ${cycleResult}`)
  }

  // Linear chain detection
  const warnings: string[] = []
  const chainWarning = detectLinearChain(rawTasks)
  if (chainWarning) {
    warnings.push(chainWarning)
  }

  // Phase 52 (DEP-01..03): cheap-model dependency validator.
  // Inherits modelOverride so --cheap propagates automatically (CONTEXT D-1).
  // validateDependencies() is fail-soft per CONTEXT D-7 — never throws.
  // On failure (LLM error, timeout, malformed JSON) it returns [] and writes
  // a dependency_validation audit entry. No try/catch required here.
  const dependencyFlags = await validateDependencies({
    parent,
    tasks: rawTasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      dependsOn: t.dependsOn,
    })),
    modelOverride,
  })

  // Build human-readable plan text (uses raw tasks with rationale for display)
  const planText = buildPlanText(rawTasks, warnings, dependencyFlags)

  return { config, planText, warnings, dependencyFlags }
}
