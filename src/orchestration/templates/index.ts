/**
 * Phase 43: Template registry and instantiation.
 *
 * Provides:
 * - TEMPLATE_REGISTRY — array of all built-in TemplateDefinition objects
 * - listTemplates() — returns name+description for each registered template
 * - getTemplate(name) — case-insensitive lookup by name
 * - instantiateTemplate(def, opts?) — maps template tasks to OrchestrationRunConfig
 * - getTemplatesForDecomposer() — formatted string for decomposer system prompt injection (TPL-04)
 *
 * Design: templates are pure data. instantiateTemplate is a pure async function
 * (async only for the runtime check side-effect). No engine state, no mutations.
 */

import { OrchestrationRunConfigSchema } from '../config-schema'
import type { OrchestrationRunConfig } from '../config-schema'
import type { TemplateDefinition } from './types'
import { nextjsSiteTemplate } from './nextjs-site'
import { restApiTemplate } from './rest-api'
import { cliToolTemplate } from './cli-tool'

/**
 * All registered built-in templates.
 * To add a new template: import it above and append it here.
 */
export const TEMPLATE_REGISTRY: readonly TemplateDefinition[] = [
  nextjsSiteTemplate,
  restApiTemplate,
  cliToolTemplate,
]

/**
 * Returns name and description for each registered template.
 * Suitable for displaying to the user in a `tm orchestrate --list-templates` output.
 */
export function listTemplates(): Array<{ name: string; description: string }> {
  return TEMPLATE_REGISTRY.map(({ name, description }) => ({ name, description }))
}

/**
 * Looks up a template by name. Comparison is case-insensitive.
 *
 * @param name - Template name (e.g. 'nextjs-site', 'NEXTJS-SITE')
 * @returns The TemplateDefinition or undefined if not found
 */
export function getTemplate(name: string): TemplateDefinition | undefined {
  const lower = name.toLowerCase()
  return TEMPLATE_REGISTRY.find((t) => t.name.toLowerCase() === lower)
}

/**
 * Options for instantiateTemplate.
 */
export interface InstantiateOptions {
  /**
   * Whether to check the runtime requirement before producing the config.
   * Defaults to true. Set to false for tests or when the caller has already
   * verified the environment.
   */
  checkRuntime?: boolean
}

/**
 * Checks that the runtime requirement is satisfied by running the command
 * and verifying exit code 0.
 *
 * @throws Error with template name and runtime command if check fails
 */
async function checkRuntimeRequirement(def: TemplateDefinition): Promise<void> {
  if (!def.runtime) return

  const { command, args, description } = def.runtime

  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(
        `Template "${def.name}" requires ${description} but runtime check failed: ` +
          `"${command}" exited with code ${exitCode}`,
      )
    }
  } catch (err) {
    // If the command itself can't be found (ENOENT), Bun.spawn throws
    if (err instanceof Error && err.message.includes('Template "')) {
      throw err
    }
    throw new Error(
      `Template "${def.name}" requires ${description} but runtime check failed: ` +
        `could not execute "${command}" — ${(err as Error).message}`,
    )
  }
}

/**
 * Instantiates a template into an OrchestrationRunConfig.
 *
 * Steps:
 * 1. If checkRuntime is true (default) and the template has a runtime field,
 *    runs the runtime command and throws if it fails.
 * 2. Maps each TemplateTask to a TaskConfig.
 * 3. Wraps in an OrchestrationRunConfig with schemaVersion: 1.
 * 4. Validates with OrchestrationRunConfigSchema and throws if invalid.
 *
 * @param def - The TemplateDefinition to instantiate
 * @param opts - Options (checkRuntime defaults to true)
 * @returns A validated OrchestrationRunConfig
 * @throws Error if runtime check fails or config fails schema validation
 */
export async function instantiateTemplate(
  def: TemplateDefinition,
  opts: InstantiateOptions = {},
): Promise<OrchestrationRunConfig> {
  const { checkRuntime = true } = opts

  if (checkRuntime && def.runtime) {
    await checkRuntimeRequirement(def)
  }

  const tasks = def.tasks.map((task) => ({
    id: task.id,
    prompt: task.prompt,
    ...(task.dependsOn !== undefined ? { dependsOn: task.dependsOn } : {}),
    ...(task.maxWorkerTurns !== undefined ? { maxWorkerTurns: task.maxWorkerTurns } : {}),
    ...(task.escalation !== undefined ? { escalation: task.escalation } : {}),
  }))

  const raw: Record<string, unknown> = {
    schemaVersion: 1,
    tasks,
  }

  if (def.defaultMaxParallel !== undefined) {
    raw.maxParallel = def.defaultMaxParallel
  }

  const result = OrchestrationRunConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `Template "${def.name}" produced an invalid OrchestrationRunConfig: ` +
        result.error.message,
    )
  }

  return result.data
}

/**
 * Returns a formatted string listing all templates with their task structures.
 * Suitable for injection into a decomposer system prompt (TPL-04).
 *
 * Format:
 *   Available templates:
 *   - nextjs-site: Next.js application with App Router, Tailwind CSS, and TypeScript
 *     Tasks: init-project → configure-tailwind, create-layout → create-homepage → add-tests
 *   ...
 */
export function getTemplatesForDecomposer(): string {
  const lines: string[] = ['Available project templates:']

  for (const tpl of TEMPLATE_REGISTRY) {
    lines.push(`\n- ${tpl.name}: ${tpl.description}`)

    if (tpl.runtime) {
      lines.push(`  Runtime requirement: ${tpl.runtime.description}`)
    }

    lines.push(`  Tasks (${tpl.tasks.length}):`)
    for (const task of tpl.tasks) {
      const deps =
        task.dependsOn && task.dependsOn.length > 0
          ? ` (depends on: ${task.dependsOn.join(', ')})`
          : ''
      lines.push(`    - ${task.id}${deps}`)
      // Include first 100 chars of prompt as context
      const promptPreview =
        task.prompt.length > 100 ? `${task.prompt.slice(0, 100)}...` : task.prompt
      lines.push(`      ${promptPreview}`)
    }
  }

  return lines.join('\n')
}
