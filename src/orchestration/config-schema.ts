/**
 * Phase 38: Zod schemas for orchestration run configuration.
 *
 * Follows the Zod-based validation pattern used throughout the project
 * (see src/agent-runner/config-schema.ts for the agent-job config pattern).
 *
 * Two schemas:
 * - TaskConfigSchema — per-task configuration with escalation policy, tool
 *   restrictions, per-task overrides for maxWorkerTurns/maxRetries, and
 *   optional provider/model/profile routing.
 * - OrchestrationRunConfigSchema — top-level config that wraps one or more
 *   tasks with run-level defaults and an optional shared budget cap.
 *
 * Design decisions (D-07 through D-10):
 * - Standalone JSON file per run, not embedded in ~/.telemachus/config.json
 * - Multi-task from the start (tasks[])
 * - Escalation as enum string: 'auto_accept' | 'require_human' (ORCH-05)
 * - Per-task scope limits with run-level defaults; maxOpusDollars is per-run
 */

import { z } from 'zod'

/**
 * Per-task configuration schema.
 *
 * Required fields: id (unique identifier), prompt (task instructions).
 * All other fields are optional overrides or defaults.
 */
export const TaskConfigSchema = z.object({
  /** Unique task identifier within the run. */
  id: z.string().min(1),
  /** Task instructions provided to the worker agent. */
  prompt: z.string().min(1),
  /** Optional named profile from KristosConfig.profiles — sets provider/model defaults. */
  profile: z.string().optional(),
  /** Explicit model override (e.g. 'claude-opus-4-5'). Takes precedence over profile. */
  model: z.string().optional(),
  /** Explicit provider override. Takes precedence over profile. */
  provider: z.enum(['anthropic', 'openai-compat', 'llamacpp']).optional(),
  /**
   * Escalation policy for reviewer output (ORCH-05, D-09).
   * - 'require_human': reviewer decision must be confirmed by a human
   * - 'auto_accept': reviewer decision is automatically accepted
   * Defaults to 'require_human' for safety.
   */
  escalation: z.enum(['auto_accept', 'require_human']).default('require_human'),
  /** Inline tool allowlist — restricts worker to named tools only. */
  allowedTools: z.array(z.string()).optional(),
  /** Per-task override for max worker agent turns. Overrides run-level default. */
  maxWorkerTurns: z.number().int().positive().optional(),
  /** Per-task override for max retries on failure. Overrides run-level default. */
  maxRetries: z.number().int().min(0).optional(),
  /**
   * IDs of tasks that must reach a terminal state before this task can be dispatched.
   * Absent = no dependencies (task can run immediately).
   * Cycle detection is enforced at the queue level, not schema level.
   * PAR-02: supports dependency-aware parallel dispatch in Phase 42.
   */
  dependsOn: z.array(z.string()).optional(),
})

/**
 * Top-level orchestration run configuration schema.
 *
 * Parsed from a standalone JSON file (e.g. my-task.orch.json) passed to
 * `tm orchestrate <config-file>` (ENTRY-01, D-07).
 */
export const OrchestrationRunConfigSchema = z.object({
  /** Config format version. Must be exactly 1. */
  schemaVersion: z.literal(1),
  /** Run-level default: max turns per worker invocation. Per-task overrides apply first. */
  maxWorkerTurns: z.number().int().positive().default(20),
  /** Run-level default: max retries per task on failure. Per-task overrides apply first. */
  maxRetries: z.number().int().min(0).default(2),
  /**
   * Shared reviewer budget across all tasks in this run. Optional — absent
   * means unlimited reviewer spend (D-10). Reviewer sessions are tracked with
   * isolated UsageSessions; the orchestration engine stops dispatching
   * reviewer turns when this budget is exhausted.
   */
  maxOpusDollars: z.number().positive().optional(),
  /**
   * Run-level default timeout in minutes for human escalation (Phase 40, ENTRY-01).
   * Used by Discord DM escalation handler; CLI ignores this (no human gate).
   * Defaults to 30 minutes.
   */
  escalationTimeoutMinutes: z.number().int().positive().default(30),
  /**
   * Maximum number of tasks that may run concurrently. Absent = no cap.
   * Phase 42 will apply a default of 3 when the parallel engine is enabled.
   * PAR-02: schema field ready for Phase 42 fan-out.
   */
  maxParallel: z.number().int().positive().optional(),
  /**
   * Project directory for the orchestration run. When set:
   * - Directory is created if it doesn't exist
   * - `git init` is run if no .git directory exists
   * - All workers use this as their CWD
   * When absent, workers use the current working directory (must be a git repo).
   */
  projectDir: z.string().optional(),
  /** Ordered list of tasks to execute. At least one task is required. */
  tasks: z.array(TaskConfigSchema).min(1),
  /**
   * Phase 53 (WAVE-01..04): Threshold (0-1) for wave-boundary fail-fast gate.
   * When wave's failure rate >= threshold, engine pauses and invokes
   * waveFailFastPrompt. Default 0.5 (applied in engine, not schema, so absent
   * field is distinguishable from explicit 0). Setting to 1.0 disables the
   * gate entirely (short-circuit, no compute overhead).
   */
  waveFailFastThreshold: z.number().min(0).max(1).optional(),
  /**
   * Phase 53 (WAVE-01..04): Transport-agnostic callback invoked when the
   * fail-fast gate triggers. CLI/Discord supply readline-prompt or
   * channel-reply implementations. Absent → engine defaults to 'continue'
   * (preserves current behavior for tests/scripted runs). Schema uses
   * z.unknown() because Zod cannot serialize callbacks; engine asserts the
   * function shape before invoking.
   */
  waveFailFastPrompt: z.unknown().optional(),
  /**
   * Phase 66 (BLAST-01): file-count ceiling on worker diffs. Workers whose
   * merge diff touches more than this many files are escalated instead of
   * merged. Default 20 — covers typical multi-file refactors while catching
   * runaway workers. Setting to a very large number effectively disables the
   * gate.
   */
  blastRadiusThreshold: z.number().int().min(1).default(20),
})

/** Inferred TypeScript type for a single task configuration. */
export type TaskConfig = z.infer<typeof TaskConfigSchema>

/** Inferred TypeScript type for a complete orchestration run configuration. */
export type OrchestrationRunConfig = z.infer<typeof OrchestrationRunConfigSchema>
