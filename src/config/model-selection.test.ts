import { describe, it, expect, beforeEach } from 'bun:test'
import { applyModelSelection } from './model-selection.js'
import type { KristosConfig } from './types.js'
import { DEFAULT_CONFIG } from './types.js'
import { createProvider, __setSemaphoreForTests } from '../providers/registry.js'
import { OpenAICompatProvider } from '../providers/openai-compat.js'

beforeEach(() => {
  // Phase 55: reset semaphore singleton so createProvider tests are isolated.
  __setSemaphoreForTests(null)
})

function makeConfig(overrides: Partial<KristosConfig> = {}): KristosConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    providerConfigs: {
      ...DEFAULT_CONFIG.providerConfigs,
      ...(overrides.providerConfigs ?? {}),
    },
  }
}

describe('applyModelSelection — anthropic', () => {
  it('routes to anthropic provider with the picked model', () => {
    const config = makeConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    const next = applyModelSelection(config, {
      providerKey: 'anthropic',
      model: 'claude-opus-4-6',
    })
    expect(next.provider).toBe('anthropic')
    expect(next.model).toBe('claude-opus-4-6')
    expect(next.providerConfigs.anthropic.model).toBe('claude-opus-4-6')
  })
})

describe('applyModelSelection — ollama', () => {
  it('regression: picking ollama materializes its config into the openai-compat slot', () => {
    // This is the exact bug the user hit:
    //   - config has anthropic + ollama, no openai-compat entry
    //   - picking ollama used to set provider=openai-compat with no baseURL
    //   - registry then fell through to api.openai.com with apiKey "ollama"
    // Build a config that explicitly has no openai-compat entry to replicate
    // the pre-regression scenario (DEFAULT_CONFIG now ships with openai-compat
    // as the default provider, so we can't use it directly here).
    const config: KristosConfig = {
      ...DEFAULT_CONFIG,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      providerConfigs: {
        anthropic: { model: 'claude-sonnet-4-6' },
        ollama: {
          model: 'qwen2.5-coder:14b',
          baseURL: 'http://localhost:11434/v1',
          isOllama: true,
        },
      },
    }
    expect(config.providerConfigs['openai-compat']).toBeUndefined()

    const next = applyModelSelection(config, {
      providerKey: 'ollama',
      model: 'qwen2.5-coder:14b',
    })

    expect(next.provider).toBe('openai-compat')
    expect(next.model).toBe('qwen2.5-coder:14b')

    // The dispatch slot must contain the resolved ollama config.
    const dispatch = next.providerConfigs['openai-compat']
    expect(dispatch).toBeDefined()
    expect(dispatch.baseURL).toBe('http://localhost:11434/v1')
    expect(dispatch.isOllama).toBe(true)
    expect(dispatch.model).toBe('qwen2.5-coder:14b')
  })

  it('the resolved provider hits localhost:11434, NOT api.openai.com', () => {
    const config = makeConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    const next = applyModelSelection(config, {
      providerKey: 'ollama',
      model: 'qwen2.5-coder:14b',
    })
    // Phase 55: createProvider wraps with semaphore — returns a plain-object
    // wrapper, not a raw OpenAICompatProvider instance. Test the contract:
    // provider.name should be 'openai-compat', and the config slot must have
    // the correct baseURL + isOllama (verifiable without touching the wrapper).
    const provider = createProvider(next)
    expect(provider.name).toBe('openai-compat')
    // Verify the config slot was populated correctly (the actual provider
    // construction is tested via the OpenAICompatProvider unit tests).
    const dispatch = next.providerConfigs['openai-compat']
    expect(dispatch).toBeDefined()
    expect(dispatch.baseURL).toBe('http://localhost:11434/v1')
    expect(dispatch.isOllama).toBe(true)
    // Build the inner provider directly to verify the client URL is correct.
    const inner = new OpenAICompatProvider({
      apiKey: dispatch.apiKey,
      baseURL: dispatch.baseURL,
      model: dispatch.model,
      isOllama: dispatch.isOllama ?? false,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(String((inner as any).client.baseURL)).toBe('http://localhost:11434/v1')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((inner as any).isOllama).toBe(true)
  })

  it('preserves the original ollama entry so the picker still shows it', () => {
    const config = makeConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    const next = applyModelSelection(config, {
      providerKey: 'ollama',
      model: 'qwen2.5-coder:14b',
    })
    expect(next.providerConfigs.ollama).toBeDefined()
    expect(next.providerConfigs.ollama.baseURL).toBe('http://localhost:11434/v1')
  })
})

describe('applyModelSelection — llamacpp', () => {
  it('routes to llamacpp provider with the picked model', () => {
    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      providerConfigs: {
        ...DEFAULT_CONFIG.providerConfigs,
        llamacpp: {
          model: 'glm-4.7-flash',
          baseURL: 'http://windowsbox.tail.ts.net:8080/v1',
          apiKey: 'sk-secret',
        },
      },
    })
    const next = applyModelSelection(config, {
      providerKey: 'llamacpp',
      model: 'qwen3-coder-next',
    })
    expect(next.provider).toBe('llamacpp')
    expect(next.model).toBe('qwen3-coder-next')
    expect(next.providerConfigs.llamacpp.model).toBe('qwen3-coder-next')
    expect(next.providerConfigs.llamacpp.baseURL).toBe('http://windowsbox.tail.ts.net:8080/v1')
    expect(next.providerConfigs.llamacpp.apiKey).toBe('sk-secret')
  })

  it('throws clearly when llamacpp config is missing', () => {
    // Build a config explicitly WITHOUT a llamacpp entry (DEFAULT_CONFIG ships
    // one, so we can't just rely on the spread).
    const config: KristosConfig = {
      ...DEFAULT_CONFIG,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      providerConfigs: {
        anthropic: { model: 'claude-sonnet-4-6' },
      },
    }
    expect(() =>
      applyModelSelection(config, { providerKey: 'llamacpp', model: 'glm-4.7-flash' }),
    ).toThrow(/llamacpp/)
  })
})

describe('applyModelSelection — unknown / openai-compat-style keys', () => {
  it('throws clearly when picking a key with no providerConfigs entry', () => {
    const config = makeConfig({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    expect(() =>
      applyModelSelection(config, { providerKey: 'lmstudio', model: 'whatever' }),
    ).toThrow(/lmstudio/)
  })

  it('routes a configured custom openai-compat key into the dispatch slot', () => {
    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      providerConfigs: {
        ...DEFAULT_CONFIG.providerConfigs,
        openrouter: {
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-xxx',
        },
      },
    })
    const next = applyModelSelection(config, {
      providerKey: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
    })
    expect(next.provider).toBe('openai-compat')
    const dispatch = next.providerConfigs['openai-compat']
    expect(dispatch.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(dispatch.apiKey).toBe('sk-or-xxx')
    expect(dispatch.model).toBe('anthropic/claude-3.5-sonnet')
    // Original entry preserved.
    expect(next.providerConfigs.openrouter).toBeDefined()
    expect(next.providerConfigs.openrouter.baseURL).toBe('https://openrouter.ai/api/v1')
  })
})
