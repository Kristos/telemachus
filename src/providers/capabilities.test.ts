import { describe, test, expect } from 'bun:test'
import { modelSupportsVision } from './capabilities.js'

describe('modelSupportsVision', () => {
  test('anthropic claude-sonnet-4-6 → true', () => {
    expect(modelSupportsVision('anthropic', 'claude-sonnet-4-6')).toBe(true)
  })
  test('anthropic claude-opus-4-6 → true', () => {
    expect(modelSupportsVision('anthropic', 'claude-opus-4-6')).toBe(true)
  })
  test('anthropic claude-haiku-4-5 → true', () => {
    expect(modelSupportsVision('anthropic', 'claude-haiku-4-5')).toBe(true)
  })
  test('anthropic claude-3-haiku → false', () => {
    expect(modelSupportsVision('anthropic', 'claude-3-haiku-20240307')).toBe(false)
  })

  test('openai gpt-4o → true', () => {
    expect(modelSupportsVision('openai', 'gpt-4o')).toBe(true)
  })
  test('openai-compat gpt-4-vision-preview → true', () => {
    expect(modelSupportsVision('openai-compat', 'gpt-4-vision-preview')).toBe(true)
  })
  test('openai-compat GLM-4.7-Flash → false', () => {
    expect(modelSupportsVision('openai-compat', 'GLM-4.7-Flash-Q4_K_M')).toBe(false)
  })

  test('llamacpp GLM-4.7-Flash → false', () => {
    expect(modelSupportsVision('llamacpp', 'GLM-4.7-Flash-Q4_K_M')).toBe(false)
  })
  test('llamacpp Qwen2-VL-7B → true', () => {
    expect(modelSupportsVision('llamacpp', 'Qwen2-VL-7B-Instruct-Q4_K_M')).toBe(true)
  })
  test('llamacpp llava-1.6-mistral → true', () => {
    expect(modelSupportsVision('llamacpp', 'llava-1.6-mistral-7b')).toBe(true)
  })
  test('ollama llava → true', () => {
    expect(modelSupportsVision('ollama', 'llava:latest')).toBe(true)
  })

  test('gemini → true', () => {
    expect(modelSupportsVision('gemini', 'gemini-2.0-flash')).toBe(true)
  })

  test('unknown provider → false', () => {
    expect(modelSupportsVision('unknown', 'anything')).toBe(false)
  })
  test('empty inputs → false', () => {
    expect(modelSupportsVision('', '')).toBe(false)
    expect(modelSupportsVision('anthropic', '')).toBe(false)
  })
})
