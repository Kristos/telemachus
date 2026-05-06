/**
 * Phase 28-03 (ROUTE-04): Routing tests proving that per-job provider/model
 * overrides flow through to createProvider as expected.
 *
 * These tests exercise createProvider directly with configs that mimic what
 * agent-runner/index.ts constructs after applying jobCfg overrides.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { createProvider, __setSemaphoreForTests } from '../providers/registry.js'
import type { KristosConfig } from '../config/types.js'

beforeAll(() => {
  // AnthropicProvider constructor checks for the API key. Set a dummy value
  // so tests 2 and 3 (which use provider:'anthropic') don't throw.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'test-key-route-04'
  }
  // Phase 55: reset semaphore singleton so tests are isolated from other
  // test files that may have created a provider with a different cap.
  __setSemaphoreForTests(null)
})

function baseConfig(overrides: Partial<KristosConfig> = {}): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {
      anthropic: { model: 'claude-sonnet-4-6' },
      llamacpp: { model: 'glm-4.7-flash', baseURL: 'http://localhost:8080/v1' },
    },
    ...overrides,
  }
}

describe('agent-runner per-job provider/model routing (ROUTE-04)', () => {
  it('job provider:llamacpp overrides top-level provider:anthropic → openai-compat provider', () => {
    // Mimics: jobCfg.provider = 'llamacpp', originalConfig.provider = 'anthropic'
    // After the ROUTE-04 fix in index.ts, kcConfig.provider = 'llamacpp'
    // Phase 55: createProvider wraps with semaphore — test the contract (name),
    // not the concrete class (instanceof fails on plain-object wrapper).
    const config = baseConfig({ provider: 'llamacpp' })
    const provider = createProvider(config)
    expect(provider.name).toBe('openai-compat')
  })

  it('job model-only override preserves top-level provider:anthropic → anthropic provider', () => {
    // Mimics: jobCfg.model = 'gpt-4o', jobCfg.provider = undefined
    // kcConfig.provider remains 'anthropic' (top-level), only model changes
    // Phase 55: test provider.name, not instanceof.
    const config = baseConfig({ model: 'gpt-4o' })
    const provider = createProvider(config)
    expect(provider.name).toBe('anthropic')
  })

  it('no job provider/model overrides → top-level config unchanged → anthropic provider', () => {
    // Mimics: jobCfg has no provider/model fields; kcConfig = originalConfig
    // Phase 55: test provider.name, not instanceof.
    const config = baseConfig()
    const provider = createProvider(config)
    expect(provider.name).toBe('anthropic')
  })
})
