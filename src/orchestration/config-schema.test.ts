import { describe, test, expect } from 'bun:test'
import { TaskConfigSchema, OrchestrationRunConfigSchema } from './config-schema.js'

describe('TaskConfigSchema', () => {
  test('minimal valid task: id + prompt', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X' })
    expect(result.id).toBe('t1')
    expect(result.prompt).toBe('do X')
  })

  test('default escalation is require_human', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X' })
    expect(result.escalation).toBe('require_human')
  })

  test('escalation auto_accept passes', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', escalation: 'auto_accept' })
    expect(result.escalation).toBe('auto_accept')
  })

  test('escalation require_human passes', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', escalation: 'require_human' })
    expect(result.escalation).toBe('require_human')
  })

  test('escalation unknown_value fails parse', () => {
    expect(() => TaskConfigSchema.parse({ id: 't1', prompt: 'do X', escalation: 'unknown_value' })).toThrow()
  })

  test('profile is optional string', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', profile: 'my-profile' })
    expect(result.profile).toBe('my-profile')
  })

  test('model is optional string', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', model: 'claude-3-5-sonnet' })
    expect(result.model).toBe('claude-3-5-sonnet')
  })

  test('provider enum accepts anthropic', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', provider: 'anthropic' })
    expect(result.provider).toBe('anthropic')
  })

  test('provider enum accepts openai-compat', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', provider: 'openai-compat' })
    expect(result.provider).toBe('openai-compat')
  })

  test('provider enum accepts llamacpp', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', provider: 'llamacpp' })
    expect(result.provider).toBe('llamacpp')
  })

  test('provider enum rejects unknown value', () => {
    expect(() => TaskConfigSchema.parse({ id: 't1', prompt: 'do X', provider: 'gemini' })).toThrow()
  })

  test('allowedTools is optional array of strings', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', allowedTools: ['bash', 'read'] })
    expect(result.allowedTools).toEqual(['bash', 'read'])
  })

  test('maxWorkerTurns is optional positive integer', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', maxWorkerTurns: 10 })
    expect(result.maxWorkerTurns).toBe(10)
  })

  test('maxRetries is optional non-negative integer', () => {
    const result = TaskConfigSchema.parse({ id: 't1', prompt: 'do X', maxRetries: 0 })
    expect(result.maxRetries).toBe(0)
  })

  test('missing id fails parse', () => {
    expect(() => TaskConfigSchema.parse({ prompt: 'do X' })).toThrow()
  })

  test('empty id fails parse', () => {
    expect(() => TaskConfigSchema.parse({ id: '', prompt: 'do X' })).toThrow()
  })

  test('missing prompt fails parse', () => {
    expect(() => TaskConfigSchema.parse({ id: 't1' })).toThrow()
  })

  test('empty prompt fails parse', () => {
    expect(() => TaskConfigSchema.parse({ id: 't1', prompt: '' })).toThrow()
  })

  test('full config with all fields passes', () => {
    const result = TaskConfigSchema.parse({
      id: 'task-full',
      prompt: 'build the feature',
      profile: 'coding',
      model: 'claude-opus-4-5',
      provider: 'anthropic',
      escalation: 'auto_accept',
      allowedTools: ['bash', 'read', 'write'],
      maxWorkerTurns: 30,
      maxRetries: 3,
    })
    expect(result.id).toBe('task-full')
    expect(result.escalation).toBe('auto_accept')
    expect(result.provider).toBe('anthropic')
    expect(result.maxWorkerTurns).toBe(30)
    expect(result.maxRetries).toBe(3)
  })
})

describe('OrchestrationRunConfigSchema', () => {
  test('minimal valid config: schemaVersion + tasks', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.schemaVersion).toBe(1)
    expect(result.tasks).toHaveLength(1)
  })

  test('defaults applied: maxWorkerTurns=20, maxRetries=2', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.maxWorkerTurns).toBe(20)
    expect(result.maxRetries).toBe(2)
  })

  test('per-task escalation default is require_human', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.tasks[0].escalation).toBe('require_human')
  })

  test('missing tasks fails parse', () => {
    expect(() => OrchestrationRunConfigSchema.parse({ schemaVersion: 1 })).toThrow()
  })

  test('empty tasks array fails parse', () => {
    expect(() => OrchestrationRunConfigSchema.parse({ schemaVersion: 1, tasks: [] })).toThrow()
  })

  test('maxOpusDollars is optional (absent = unlimited)', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.maxOpusDollars).toBeUndefined()
  })

  test('maxOpusDollars can be set', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      maxOpusDollars: 5.0,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.maxOpusDollars).toBe(5.0)
  })

  test('schemaVersion must be exactly 1', () => {
    expect(() => OrchestrationRunConfigSchema.parse({
      schemaVersion: 2,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })).toThrow()
  })

  test('per-task maxWorkerTurns overrides run-level default', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      maxWorkerTurns: 20,
      tasks: [{ id: 't1', prompt: 'do X', maxWorkerTurns: 5 }],
    })
    expect(result.tasks[0].maxWorkerTurns).toBe(5)
  })

  test('task with escalation auto_accept passes', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X', escalation: 'auto_accept' }],
    })
    expect(result.tasks[0].escalation).toBe('auto_accept')
  })

  test('task with escalation require_human passes', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X', escalation: 'require_human' }],
    })
    expect(result.tasks[0].escalation).toBe('require_human')
  })

  test('task with invalid escalation fails parse', () => {
    expect(() => OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X', escalation: 'bad_value' }],
    })).toThrow()
  })

  test('full config with multiple tasks passes', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      maxWorkerTurns: 25,
      maxRetries: 1,
      maxOpusDollars: 10.0,
      tasks: [
        { id: 'task-a', prompt: 'research X', escalation: 'require_human' },
        { id: 'task-b', prompt: 'implement Y', escalation: 'auto_accept', maxWorkerTurns: 10 },
      ],
    })
    expect(result.tasks).toHaveLength(2)
    expect(result.maxOpusDollars).toBe(10.0)
    expect(result.tasks[1].maxWorkerTurns).toBe(10)
  })

  test('escalationTimeoutMinutes defaults to 30 when omitted', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.escalationTimeoutMinutes).toBe(30)
  })

  test('escalationTimeoutMinutes can be set to custom value', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      escalationTimeoutMinutes: 15,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.escalationTimeoutMinutes).toBe(15)
  })
})

describe('dependsOn and maxParallel', () => {
  test('TaskConfigSchema accepts dependsOn array of strings', () => {
    const result = TaskConfigSchema.parse({ id: 'a', prompt: 'do stuff', dependsOn: ['b'] })
    expect(result.dependsOn).toEqual(['b'])
  })

  test('TaskConfigSchema without dependsOn parses successfully (backward compat)', () => {
    const result = TaskConfigSchema.parse({ id: 'a', prompt: 'do stuff' })
    expect(result.dependsOn).toBeUndefined()
  })

  test('OrchestrationRunConfigSchema accepts maxParallel: 2', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
      maxParallel: 2,
    })
    expect(result.maxParallel).toBe(2)
  })

  test('OrchestrationRunConfigSchema without maxParallel parses (default undefined)', () => {
    const result = OrchestrationRunConfigSchema.parse({
      schemaVersion: 1,
      tasks: [{ id: 't1', prompt: 'do X' }],
    })
    expect(result.maxParallel).toBeUndefined()
  })

  test('dependsOn referencing a non-existent task ID is accepted by schema', () => {
    // Validation of referenced IDs is at queue level, not schema level
    const result = TaskConfigSchema.parse({ id: 'a', prompt: 'do stuff', dependsOn: ['nonexistent-id'] })
    expect(result.dependsOn).toEqual(['nonexistent-id'])
  })
})

describe('OrchestrationRunConfigSchema — Phase 53 wave fail-fast fields', () => {
  const minimalConfig = {
    schemaVersion: 1 as const,
    tasks: [{ id: 'a', prompt: 'do thing' }],
  }

  test('parses without waveFailFastThreshold (optional, no schema default)', () => {
    const result = OrchestrationRunConfigSchema.safeParse(minimalConfig)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.waveFailFastThreshold).toBeUndefined()
    }
  })

  const validThresholds: number[] = [0, 0.5, 1.0]
  for (const val of validThresholds) {
    test(`parses waveFailFastThreshold = ${val}`, () => {
      const result = OrchestrationRunConfigSchema.safeParse({
        ...minimalConfig,
        waveFailFastThreshold: val,
      })
      expect(result.success).toBe(true)
    })
  }

  const invalidThresholds: unknown[] = [-0.1, 1.1, 2, 'half']
  for (const val of invalidThresholds) {
    test(`rejects waveFailFastThreshold = ${JSON.stringify(val)}`, () => {
      const result = OrchestrationRunConfigSchema.safeParse({
        ...minimalConfig,
        waveFailFastThreshold: val,
      })
      expect(result.success).toBe(false)
    })
  }

  test('accepts a function value for waveFailFastPrompt', () => {
    const cb = async () => 'continue' as const
    const result = OrchestrationRunConfigSchema.safeParse({
      ...minimalConfig,
      waveFailFastPrompt: cb,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.waveFailFastPrompt).toBe('function')
    }
  })

  test('accepts undefined waveFailFastPrompt (field optional)', () => {
    const result = OrchestrationRunConfigSchema.safeParse(minimalConfig)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.waveFailFastPrompt).toBeUndefined()
    }
  })
})
