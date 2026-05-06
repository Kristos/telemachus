/**
 * Phase 43: Template registry and instantiation tests.
 *
 * Tests cover:
 * - instantiateTemplate produces valid OrchestrationRunConfig
 * - Task mapping (id, prompt, dependsOn)
 * - schemaVersion: 1 is set
 * - getTemplate lookup and missing case
 * - listTemplates returns 3+ entries
 * - Runtime check failure path
 * - getTemplatesForDecomposer returns non-empty string
 */

import { describe, test, expect } from 'bun:test'
import { OrchestrationRunConfigSchema } from '../config-schema'
import type { TemplateDefinition } from './types'
import {
  listTemplates,
  getTemplate,
  instantiateTemplate,
  getTemplatesForDecomposer,
} from './index'

// A minimal valid template with no runtime requirement, for happy-path tests
const minimalTemplate: TemplateDefinition = {
  name: 'minimal-test',
  description: 'A minimal template for testing',
  tasks: [
    {
      id: 'task-a',
      prompt: 'Do thing A',
    },
    {
      id: 'task-b',
      prompt: 'Do thing B after A',
      dependsOn: ['task-a'],
    },
  ],
}

const templateWithRuntime: TemplateDefinition = {
  name: 'runtime-test',
  description: 'Template that requires a runtime',
  runtime: {
    command: 'node',
    args: ['--version'],
    description: 'Node.js runtime',
  },
  tasks: [
    {
      id: 'only-task',
      prompt: 'Do the thing',
    },
  ],
}

const templateWithBadRuntime: TemplateDefinition = {
  name: 'bad-runtime-test',
  description: 'Template with a non-existent runtime',
  runtime: {
    command: 'nonexistent-binary-xyz-abc',
    args: ['--version'],
    description: 'Nonexistent runtime',
  },
  tasks: [
    {
      id: 'only-task',
      prompt: 'Do the thing',
    },
  ],
}

describe('instantiateTemplate', () => {
  test('produces OrchestrationRunConfig that passes schema validation', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    const result = OrchestrationRunConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test('sets schemaVersion: 1', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    expect(config.schemaVersion).toBe(1)
  })

  test('maps TemplateTask id to TaskConfig id', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    expect(config.tasks[0].id).toBe('task-a')
    expect(config.tasks[1].id).toBe('task-b')
  })

  test('maps TemplateTask prompt to TaskConfig prompt', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    expect(config.tasks[0].prompt).toBe('Do thing A')
    expect(config.tasks[1].prompt).toBe('Do thing B after A')
  })

  test('maps TemplateTask dependsOn to TaskConfig dependsOn', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    expect(config.tasks[0].dependsOn).toBeUndefined()
    expect(config.tasks[1].dependsOn).toEqual(['task-a'])
  })

  test('includes all tasks from the template', async () => {
    const config = await instantiateTemplate(minimalTemplate, { checkRuntime: false })
    expect(config.tasks).toHaveLength(2)
  })

  test('runtime check passes when command succeeds (checkRuntime: true)', async () => {
    // node --version should succeed on any dev machine
    const config = await instantiateTemplate(templateWithRuntime, { checkRuntime: true })
    expect(config.schemaVersion).toBe(1)
    expect(config.tasks).toHaveLength(1)
  })

  test('throws when runtime check fails', async () => {
    await expect(
      instantiateTemplate(templateWithBadRuntime, { checkRuntime: true }),
    ).rejects.toThrow('nonexistent-binary-xyz-abc')
  })

  test('error message includes template name and runtime command on failure', async () => {
    try {
      await instantiateTemplate(templateWithBadRuntime, { checkRuntime: true })
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('bad-runtime-test')
      expect(msg).toContain('nonexistent-binary-xyz-abc')
    }
  })

  test('runtime check is skipped when checkRuntime: false even for template with runtime field', async () => {
    // This should NOT throw even though the binary doesn't exist
    const config = await instantiateTemplate(templateWithBadRuntime, { checkRuntime: false })
    expect(config.schemaVersion).toBe(1)
  })

  test('default checkRuntime is true (runtime is checked)', async () => {
    // Calling without options should check runtime
    await expect(
      instantiateTemplate(templateWithBadRuntime),
    ).rejects.toThrow()
  })
})

describe('getTemplate', () => {
  test('returns the nextjs-site template by name', () => {
    const tpl = getTemplate('nextjs-site')
    expect(tpl).toBeDefined()
    expect(tpl?.name).toBe('nextjs-site')
  })

  test('returns the rest-api template by name', () => {
    const tpl = getTemplate('rest-api')
    expect(tpl).toBeDefined()
    expect(tpl?.name).toBe('rest-api')
  })

  test('returns the cli-tool template by name', () => {
    const tpl = getTemplate('cli-tool')
    expect(tpl).toBeDefined()
    expect(tpl?.name).toBe('cli-tool')
  })

  test('returns undefined for a nonexistent template', () => {
    const tpl = getTemplate('nonexistent-template-xyz')
    expect(tpl).toBeUndefined()
  })

  test('lookup is case-insensitive', () => {
    const tpl = getTemplate('NEXTJS-SITE')
    expect(tpl).toBeDefined()
  })
})

describe('listTemplates', () => {
  test('returns at least 3 entries', () => {
    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(3)
  })

  test('each entry has name and description', () => {
    const templates = listTemplates()
    for (const t of templates) {
      expect(typeof t.name).toBe('string')
      expect(typeof t.description).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  test('includes nextjs-site, rest-api, cli-tool', () => {
    const names = listTemplates().map((t) => t.name)
    expect(names).toContain('nextjs-site')
    expect(names).toContain('rest-api')
    expect(names).toContain('cli-tool')
  })
})

describe('getTemplatesForDecomposer', () => {
  test('returns a non-empty string', () => {
    const result = getTemplatesForDecomposer()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  test('includes template names', () => {
    const result = getTemplatesForDecomposer()
    expect(result).toContain('nextjs-site')
    expect(result).toContain('rest-api')
    expect(result).toContain('cli-tool')
  })

  test('includes task structure info', () => {
    const result = getTemplatesForDecomposer()
    // Should mention tasks in some form
    expect(result.toLowerCase()).toContain('task')
  })
})

describe('built-in template shapes', () => {
  test('nextjs-site has runtime field', () => {
    const tpl = getTemplate('nextjs-site')!
    expect(tpl.runtime).toBeDefined()
    expect(tpl.runtime?.command).toBe('node')
  })

  test('rest-api has runtime field', () => {
    const tpl = getTemplate('rest-api')!
    expect(tpl.runtime).toBeDefined()
  })

  test('cli-tool has runtime field', () => {
    const tpl = getTemplate('cli-tool')!
    expect(tpl.runtime).toBeDefined()
  })

  test('nextjs-site has dependsOn edges', () => {
    const tpl = getTemplate('nextjs-site')!
    const withDeps = tpl.tasks.filter((t) => t.dependsOn && t.dependsOn.length > 0)
    expect(withDeps.length).toBeGreaterThan(0)
  })

  test('rest-api has dependsOn edges', () => {
    const tpl = getTemplate('rest-api')!
    const withDeps = tpl.tasks.filter((t) => t.dependsOn && t.dependsOn.length > 0)
    expect(withDeps.length).toBeGreaterThan(0)
  })

  test('cli-tool has dependsOn edges', () => {
    const tpl = getTemplate('cli-tool')!
    const withDeps = tpl.tasks.filter((t) => t.dependsOn && t.dependsOn.length > 0)
    expect(withDeps.length).toBeGreaterThan(0)
  })

  test('each built-in template round-trips through instantiateTemplate', async () => {
    for (const { name } of listTemplates()) {
      const tpl = getTemplate(name)!
      const config = await instantiateTemplate(tpl, { checkRuntime: false })
      const result = OrchestrationRunConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    }
  })
})
