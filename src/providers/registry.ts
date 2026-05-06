import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatProvider } from './openai-compat.js'
import { FallbackProvider } from './fallback.js'
import { LLMSemaphore } from './semaphore.js'
import type { Provider } from './types.js'
import type { KristosConfig } from '../config/types.js'

// Phase 55 (CONC-01): process-wide semaphore. Initialized lazily by
// createProvider from config.maxInflightLLMRequests. Shared across every
// Provider instance — that is the entire point. Tests can swap it via
// __setSemaphoreForTests().
let _semaphore: LLMSemaphore | null = null

export function __setSemaphoreForTests(sem: LLMSemaphore | null): void {
  _semaphore = sem
}

/**
 * Phase 59 (ROUTE-07): Expose the same lazily-initialized process-wide
 * semaphore that createProvider uses, so src/discord/router-assembly.ts
 * can wrap RouterProvider with it (outer wrap). DO NOT construct a second
 * semaphore — ROUTE-07 mandates one outer semaphore per process.
 */
export function getOrCreateSemaphore(config: KristosConfig): LLMSemaphore {
  if (_semaphore === null) {
    _semaphore = new LLMSemaphore({ max: config.maxInflightLLMRequests })
  }
  return _semaphore
}

/** Wrap any Provider so every stream() call acquires a semaphore slot. */
export function wrapWithSemaphore(inner: Provider, sem: LLMSemaphore): Provider {
  return {
    name: inner.name,
    async stream(messages, tools, opts) {
      const release = await sem.acquire(inner.name)
      try {
        return await inner.stream(messages, tools, opts)
      } finally {
        release()
      }
    },
  }
}

export function buildProvider(
  providerName: KristosConfig['provider'],
  providerConfigs: KristosConfig['providerConfigs'],
  defaultModel: string,
): Provider {
  const providerConfig = providerConfigs[providerName]
  if (providerName === 'anthropic') {
    const apiKey = providerConfig?.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — add to config or environment')
    return new AnthropicProvider(apiKey, providerConfig?.model ?? defaultModel)
  }
  if (providerName === 'llamacpp') {
    return new OpenAICompatProvider({
      apiKey: providerConfig?.apiKey ?? 'llamacpp',
      baseURL: providerConfig?.baseURL ?? 'http://localhost:8080/v1',
      model: providerConfig?.model ?? defaultModel,
      isOllama: false,
    })
  }
  return new OpenAICompatProvider({
    apiKey: providerConfig?.apiKey,
    baseURL: providerConfig?.baseURL,
    model: providerConfig?.model ?? defaultModel,
    isOllama: providerConfig?.isOllama ?? false,
  })
}

export function createProvider(config: KristosConfig): Provider {
  const primary = buildProvider(config.provider, config.providerConfigs, config.model)

  const inner =
    config.fallbackProvider && config.fallbackProvider !== config.provider
      ? new FallbackProvider(primary, buildProvider(config.fallbackProvider, config.providerConfigs, config.model))
      : primary

  // Phase 55: wrap the final Provider with the process-wide semaphore.
  // Lazy-init from config so the cap is honored on first use and shared
  // for the lifetime of the process. FallbackProvider inherits transparently
  // because wrapping happens OUTSIDE it — every FallbackProvider.stream call
  // goes through semaphore.acquire → inner.stream (which internally tries
  // primary then fallback). The cap is on concurrent *outer* calls.
  if (_semaphore === null) {
    _semaphore = new LLMSemaphore({ max: config.maxInflightLLMRequests })
  }
  return wrapWithSemaphore(inner, _semaphore)
}
