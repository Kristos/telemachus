/**
 * Phase 43: Template type system for orchestration project templates.
 *
 * Templates are pure data — typed TemplateDefinition objects that describe
 * a set of tasks and their dependencies. They produce OrchestrationRunConfig
 * objects via instantiateTemplate, with no engine changes required.
 *
 * Design: three interfaces that mirror the TaskConfig schema but are
 * free of runtime Zod types — templates are authored as plain TypeScript objects.
 */

/**
 * Runtime requirement for a template.
 *
 * The runtime is checked before instantiation by running the command with the
 * given args and verifying that exit code === 0. This prevents launching agent
 * tasks that are guaranteed to fail due to a missing runtime environment.
 *
 * Example: { command: 'node', args: ['--version'], description: 'Node.js runtime' }
 */
export interface RuntimeRequirement {
  /** The command to execute for the runtime check (e.g. 'node', 'python3'). */
  command: string
  /** Arguments passed to the command (e.g. ['--version']). */
  args: string[]
  /** Human-readable description shown in error messages. */
  description: string
}

/**
 * A single task within a template definition.
 *
 * Maps 1:1 to a TaskConfig when instantiated. Only the fields a template
 * author typically controls are present — run-level defaults handle the rest.
 */
export interface TemplateTask {
  /** Unique identifier within this template's task list. */
  id: string
  /** Task instructions provided to the worker agent. */
  prompt: string
  /** IDs of other tasks in this template that must complete before this one. */
  dependsOn?: string[]
  /** Optional per-task override for max worker turns. */
  maxWorkerTurns?: number
  /**
   * Escalation policy for this task.
   * - 'require_human': reviewer decision requires human confirmation (default)
   * - 'auto_accept': reviewer decision is automatically accepted
   */
  escalation?: 'auto_accept' | 'require_human'
}

/**
 * A complete template definition.
 *
 * Templates are registered in the template registry and can be listed,
 * retrieved by name, and instantiated into OrchestrationRunConfig objects.
 */
export interface TemplateDefinition {
  /** Unique template name used for lookup (e.g. 'nextjs-site'). */
  name: string
  /** Human-readable description shown in listings and decomposer context. */
  description: string
  /**
   * Optional runtime requirement. When present, instantiateTemplate checks
   * the runtime before producing the config. Templates without a runtime field
   * skip the runtime check entirely.
   */
  runtime?: RuntimeRequirement
  /** Ordered or dependency-linked list of tasks this template provisions. */
  tasks: TemplateTask[]
  /**
   * Optional default for the maxParallel run config field.
   * When set, instantiateTemplate applies it to the resulting OrchestrationRunConfig.
   */
  defaultMaxParallel?: number
}
