import { test, expect, beforeEach, afterEach } from 'bun:test'
import { fetchOllamaModels } from './ollama-tags.js'

const originalFetch = globalThis.fetch
let lastUrl: string | undefined

beforeEach(() => {
  lastUrl = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  globalThis.fetch = ((input: any) => {
    const url = typeof input === 'string' ? input : input.url
    lastUrl = url
    return Promise.resolve(impl(url))
  }) as any
}

test('success path returns model names', async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({
        models: [{ name: 'qwen2.5-coder:14b' }, { name: 'llama3.1:8b' }],
      }),
      { status: 200 },
    ),
  )
  const result = await fetchOllamaModels('http://localhost:11434/v1')
  expect(result).toEqual(['qwen2.5-coder:14b', 'llama3.1:8b'])
})

test('base URL normalization hits /api/tags regardless of suffix', async () => {
  mockFetch(() => new Response(JSON.stringify({ models: [] }), { status: 200 }))

  await fetchOllamaModels('http://localhost:11434/v1')
  expect(lastUrl?.endsWith('/api/tags')).toBe(true)
  expect(lastUrl).toBe('http://localhost:11434/api/tags')

  await fetchOllamaModels('http://localhost:11434/v1/')
  expect(lastUrl).toBe('http://localhost:11434/api/tags')

  await fetchOllamaModels('http://localhost:11434')
  expect(lastUrl).toBe('http://localhost:11434/api/tags')

  await fetchOllamaModels('http://localhost:11434/')
  expect(lastUrl).toBe('http://localhost:11434/api/tags')
})

test('failure path returns [] on network error', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as any
  const result = await fetchOllamaModels('http://localhost:11434/v1')
  expect(result).toEqual([])
})

test('malformed JSON (no models key) returns []', async () => {
  mockFetch(() => new Response(JSON.stringify({}), { status: 200 }))
  const result = await fetchOllamaModels('http://localhost:11434/v1')
  expect(result).toEqual([])
})
