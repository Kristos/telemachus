import { describe, it, expect } from 'bun:test'
import { getOllamaToolWarning } from './ollama-warning.js'
import type { KristosConfig } from './types.js'

function makeConfig(providerKey: string, model: string, isOllama = true): KristosConfig {
  return {
    provider: providerKey as KristosConfig['provider'],
    model,
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {
      [providerKey]: {
        model,
        baseURL: 'http://localhost:11434/v1',
        isOllama,
      },
    },
  }
}

describe('getOllamaToolWarning', () => {
  it('warns for llama3:latest', () => {
    const w = getOllamaToolWarning(makeConfig('openai-compat', 'llama3:latest'))
    expect(w).not.toBeNull()
    expect(w).toContain('llama3:latest')
    expect(w).toContain('qwen2.5-coder')
    expect(w).toContain('llama3.1')
    expect(w).toContain('mistral-large')
  })

  it('warns for phi3', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'phi3'))).toContain('phi3')
  })

  it('warns for gemma:2b', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'gemma:2b'))).toContain('gemma:2b')
  })

  it('warns for gemma:7b', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'gemma:7b'))).toContain('gemma:7b')
  })

  it('warns for tinyllama', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'tinyllama:latest'))).toContain('tinyllama')
  })

  it('warns for uppercase LLAMA3:latest', () => {
    const w = getOllamaToolWarning(makeConfig('openai-compat', 'LLAMA3:latest'))
    expect(w).not.toBeNull()
    expect(w).toContain('llama3:latest')
  })

  it('does NOT warn for llama3.1', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'llama3.1:latest'))).toBeNull()
  })

  it('does NOT warn for llama3.2', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'llama3.2'))).toBeNull()
  })

  it('does NOT warn for qwen2.5-coder:14b', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'qwen2.5-coder:14b'))).toBeNull()
  })

  it('does NOT warn for mistral-large', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'mistral-large'))).toBeNull()
  })

  it('does NOT warn when provider is not Ollama', () => {
    expect(getOllamaToolWarning(makeConfig('anthropic', 'llama3', false))).toBeNull()
  })

  it('does NOT warn for gemma:27b (larger gemma variant)', () => {
    expect(getOllamaToolWarning(makeConfig('openai-compat', 'gemma:27b'))).toBeNull()
  })
})
