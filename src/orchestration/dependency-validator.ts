/**
 * Phase 52: Dependency Validator — types, Zod schema, rendering helper, and validator function.
 *
 * This module is the single source of truth for the DependencyFlag shape used
 * across the validator LLM call (Plan 02) and the decomposer integration
 * (Plan 03). The render helper is pure and independently testable.
 *
 * Exports:
 *   - DependencyFlag: individual flagged missing dependency edge
 *   - DependencyValidatorResponseSchema: Zod schema for the validator's LLM JSON output
 *   - DependencyValidatorResponse: inferred TypeScript type from the schema
 *   - renderDependencyWarningsSection: pure render helper for plan preview
 *   - ValidatorTaskInput: input shape for the formatter
 *   - formatTaskTableForValidator: compact table formatter for LLM input
 *   - buildValidatorSystemPrompt: system prompt builder for the validator
 *   - validateDependencies: main validator function (Plan 02)
 *
 * DEP-01, DEP-02, DEP-03
 */

import { z } from 'zod'
import { runSubagent, type SubagentParent } from '../agent/subagent.js'
import { extractJSON } from './decomposer.js'
import { appendAuditEntry } from '../security/audit.js'
import type { Provider } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single flagged missing dependency edge, as returned by the validator LLM. */
export interface DependencyFlag {
  /** The task ID that is suspected to be missing a dependsOn edge. */
  taskId: string
  /** The task ID that should be listed in dependsOn. */
  suggestedDep: string
  /** Human-readable explanation of why this dependency is needed. */
  rationale: string
}

// ---------------------------------------------------------------------------
// Zod schema for the validator's LLM JSON response
// ---------------------------------------------------------------------------

export const DependencyValidatorResponseSchema = z.object({
  flags: z.array(
    z.object({
      taskId: z.string().min(1),
      suggestedDep: z.string().min(1),
      rationale: z.string().min(1),
    }),
  ),
})

export type DependencyValidatorResponse = z.infer<typeof DependencyValidatorResponseSchema>

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task-table formatter and system prompt builder (Plan 02, Task 1)
// ---------------------------------------------------------------------------

/** Input shape for the formatter — matches the RawTask shape used by decomposer. */
export interface ValidatorTaskInput {
  id: string
  prompt: string
  dependsOn?: string[]
}

/**
 * Format a list of tasks as a compact table for the validator LLM.
 *
 * Per CONTEXT decision 4: compact table with taskId, prompt preview (≤80 chars),
 * and current dependsOn. Output is deterministic so the validator always receives
 * the same input for the same task list.
 */
export function formatTaskTableForValidator(tasks: ValidatorTaskInput[]): string {
  const header = 'taskId | prompt (first 80 chars) | dependsOn'
  const sep = '-------|-------------------------|----------'
  const rows = tasks.map((t) => {
    const preview = t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}...` : t.prompt
    const deps = t.dependsOn && t.dependsOn.length > 0 ? t.dependsOn.join(', ') : '(none)'
    return `${t.id} | ${preview} | ${deps}`
  })
  return [header, sep, ...rows].join('\n')
}

/**
 * Build the validator system prompt embedding the task table.
 *
 * Instructs the LLM to identify suspected missing dependsOn edges and return
 * ONLY a JSON object in ```json fences matching { flags: [...] }. Follows
 * the same prompt style as buildDecomposerSystemPrompt in decomposer.ts.
 */
export function buildValidatorSystemPrompt(taskTable: string): string {
  return `You are a dependency validator for an orchestration plan. Your job is to identify suspected MISSING dependsOn edges in the task list below.

TASK TABLE:
${taskTable}

VALIDATION RULES:
- A task that writes or configures files inside a directory another task creates LIKELY depends on the creator (e.g. configure-tailwind writing into the project root needs init-project to run first)
- A task that imports / consumes code defined by another task LIKELY depends on the definer
- A task that reads runtime state another task initialises LIKELY depends on the initialiser
- Only flag edges that are clearly suspicious — do NOT flag plausible parallel work
- Each rationale MUST explain the concrete file/code/init relationship in plain English

OUTPUT REQUIREMENTS:
You MUST respond with ONLY a valid JSON object wrapped in \`\`\`json ... \`\`\` fences.

Schema:
{
  "flags": [
    {
      "taskId": "<task that has the suspicious gap>",
      "suggestedDep": "<task ID that should appear in its dependsOn>",
      "rationale": "<human-readable why — concrete file/code relationship>"
    }
  ]
}

If no suspicious missing edges exist, return: { "flags": [] }

Respond with ONLY the JSON object in \`\`\`json ... \`\`\` fences.`
}

/**
 * Render the "Dependency Warnings" section for inclusion in the plan preview.
 *
 * Returns empty string when flags is empty so callers can unconditionally
 * concatenate without producing trailing whitespace for clean plans
 * (criterion 4: byte-identical output when no flags are present).
 *
 * Format per CONTEXT.md decision 5:
 *   \nDependency Warnings:\n  ⚠ task-B may need dependsOn: task-A — {rationale}
 */
export function renderDependencyWarningsSection(flags: DependencyFlag[]): string {
  if (flags.length === 0) return ''
  const lines = ['', 'Dependency Warnings:']
  for (const f of flags) {
    lines.push(`  ⚠ ${f.taskId} may need dependsOn: ${f.suggestedDep} — ${f.rationale}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// validateDependencies (Plan 02, Task 2)
// ---------------------------------------------------------------------------

/** Baseline wall-clock budget for small plans (≤ 5 tasks). */
const VALIDATOR_BASE_TIMEOUT_MS = 10_000

/** Extra wall-clock granted per task above the baseline, to account for GLM throughput. */
const VALIDATOR_TIMEOUT_PER_TASK_MS = 2_000

/** Hard ceiling — never wait longer than this regardless of task count. */
const VALIDATOR_MAX_TIMEOUT_MS = 45_000

/**
 * Compute the wall-clock budget for the validator LLM call. Small plans finish
 * in a few seconds; larger plans need proportionally more time because the
 * system prompt (task table) grows with task count and cheap models generate
 * slower than cloud models.
 *
 * Examples (per-task 2s above the 10s baseline, capped at 45s):
 *   3 tasks → 10_000 ms
 *   5 tasks → 10_000 ms
 *   8 tasks → 16_000 ms
 *  13 tasks → 26_000 ms   ← the 2026-04-14 incident was here
 *  20 tasks → 40_000 ms
 *  50 tasks → 45_000 ms   (hit the ceiling)
 */
export function computeValidatorTimeoutMs(taskCount: number): number {
  const overBaseline = Math.max(0, taskCount - 5)
  const scaled = VALIDATOR_BASE_TIMEOUT_MS + overBaseline * VALIDATOR_TIMEOUT_PER_TASK_MS
  return Math.min(scaled, VALIDATOR_MAX_TIMEOUT_MS)
}

/** Sentinel symbol used by Promise.race to detect a timeout win. */
const TIMEOUT_SENTINEL = Symbol('validator_timeout')

export interface ValidateDependenciesOptions {
  parent: SubagentParent
  tasks: ValidatorTaskInput[]
  /** Same model override the decomposer used. Inherited verbatim per CONTEXT decision 1. */
  modelOverride?: { provider: 'anthropic' | 'openai-compat' | 'llamacpp'; model: string }
  /**
   * Override the computed timeout for testing. Defaults to
   * `computeValidatorTimeoutMs(tasks.length)` — scales with plan size.
   * @internal test-only — do not set in production code.
   */
  timeoutMs?: number
}

/**
 * Validate the decomposer's dependsOn edges by asking a cheap-model second pass
 * to flag suspected missing edges. Always advisory: every failure path returns
 * an empty array and writes a dependency_validation audit entry — never throws.
 *
 * Note: the runSubagent call is not cancellable. On timeout the inner call
 * continues in the background until it returns; we simply stop waiting for it.
 * This is acceptable per CONTEXT — the validator's contract is "advisory, never blocks".
 *
 * Per CONTEXT decisions 1, 6, 7, 8, 9. DEP-01, DEP-03.
 */
export async function validateDependencies(
  opts: ValidateDependenciesOptions,
): Promise<DependencyFlag[]> {
  const { parent, tasks, modelOverride } = opts
  const timeoutMs = opts.timeoutMs ?? computeValidatorTimeoutMs(tasks.length)

  const validatorModel =
    modelOverride?.model ?? (parent.provider as { name?: string }).name

  const ts = () => new Date().toISOString()
  const sessionId = 'dependency-validator'
  const platform = process.platform

  const taskTable = formatTaskTableForValidator(tasks)
  const systemPrompt = buildValidatorSystemPrompt(taskTable)

  // Build provider override (mirrors decomposer.ts:227-237 pattern exactly)
  let providerOverride: Provider | undefined
  if (modelOverride) {
    try {
      const { createProvider } = await import('../providers/registry.js')
      const { loadConfig } = await import('../config/loader.js')
      const kcConfig = await loadConfig(process.cwd())
      const overrideConfig = {
        ...kcConfig,
        provider: modelOverride.provider,
        model: modelOverride.model,
      }
      providerOverride = createProvider(overrideConfig)
    } catch (err) {
      process.stderr.write(
        `[dependency-validator] warn: provider override failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      void appendAuditEntry({
        ts: ts(),
        kind: 'dependency_validation',
        sessionId,
        platform,
        taskCount: tasks.length,
        flagCount: 0,
        trigger: 'llm_error',
        validatorModel,
      })
      return []
    }
  }

  // Race the runSubagent call against a wall-clock timeout
  const subagentPromise = runSubagent(
    parent,
    'Validate the task list in the system prompt.',
    {
      provider: providerOverride,
      systemPrompt,
      maxIterations: 1,
    },
  )
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
    setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs),
  )

  const raced = await Promise.race([subagentPromise, timeoutPromise])

  if (raced === TIMEOUT_SENTINEL) {
    process.stderr.write(`[dependency-validator] warn: validator call timed out after 10s\n`)
    void appendAuditEntry({
      ts: ts(),
      kind: 'dependency_validation',
      sessionId,
      platform,
      taskCount: tasks.length,
      flagCount: 0,
      trigger: 'timeout',
      validatorModel,
    })
    return []
  }

  const result = raced

  if (result.error) {
    process.stderr.write(
      `[dependency-validator] warn: LLM call failed: ${result.error.message}\n`,
    )
    void appendAuditEntry({
      ts: ts(),
      kind: 'dependency_validation',
      sessionId,
      platform,
      taskCount: tasks.length,
      flagCount: 0,
      trigger: 'llm_error',
      validatorModel,
    })
    return []
  }

  const raw = extractJSON(result.text)
  if (!raw) {
    process.stderr.write(`[dependency-validator] warn: validator output not parseable\n`)
    void appendAuditEntry({
      ts: ts(),
      kind: 'dependency_validation',
      sessionId,
      platform,
      taskCount: tasks.length,
      flagCount: 0,
      trigger: 'parse_error',
      validatorModel,
    })
    return []
  }

  const parsed = DependencyValidatorResponseSchema.safeParse(raw)
  if (!parsed.success) {
    process.stderr.write(`[dependency-validator] warn: validator output not parseable\n`)
    void appendAuditEntry({
      ts: ts(),
      kind: 'dependency_validation',
      sessionId,
      platform,
      taskCount: tasks.length,
      flagCount: 0,
      trigger: 'parse_error',
      validatorModel,
    })
    return []
  }

  const flags = parsed.data.flags
  void appendAuditEntry({
    ts: ts(),
    kind: 'dependency_validation',
    sessionId,
    platform,
    taskCount: tasks.length,
    flagCount: flags.length,
    trigger: 'success',
    validatorModel,
  })
  return flags
}
