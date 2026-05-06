import { test, expect, beforeEach, afterEach } from 'bun:test'
import { fetchLlamaCppModels } from './llamacpp-models.js'

const originalFetch = globalThis.fetch
let lastUrl: string | undefined
let lastHeaders: Record<string, string> | undefined

beforeEach(() => {
  lastUrl = undefined
  lastHeaders = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    lastUrl = url
    lastHeaders = (init?.headers as Record<string, string>) ?? {}
    return Promise.resolve(impl(url))
  }) as any
}

test('success path returns model ids', async () => {
  mockFetch(() =>
    new Response(
      JSON.stringify({
        data: [{ id: 'glm-4.7-flash' }, { id: 'qwen3-coder-next' }],
      }),
      { status: 200 },
    ),
  )
  const result = await fetchLlamaCppModels('http://localhost:8080/v1')
  expect(result).toEqual(['glm-4.7-flash', 'qwen3-coder-next'])
})

test('base URL normalization hits /v1/models regardless of suffix', async () => {
  mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))

  await fetchLlamaCppModels('http://localhost:8080/v1')
  expect(lastUrl).toBe('http://localhost:8080/v1/models')

  await fetchLlamaCppModels('http://localhost:8080/v1/')
  expect(lastUrl).toBe('http://localhost:8080/v1/models')

  await fetchLlamaCppModels('http://localhost:8080')
  expect(lastUrl).toBe('http://localhost:8080/v1/models')

  await fetchLlamaCppModels('http://localhost:8080/')
  expect(lastUrl).toBe('http://localhost:8080/v1/models')
})

test('sends Authorization header when apiKey provided', async () => {
  mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
  await fetchLlamaCppModels('http://localhost:8080/v1', 'sk-secret')
  expect(lastHeaders?.['Authorization']).toBe('Bearer sk-secret')
})

test('no Authorization header when apiKey omitted', async () => {
  mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
  await fetchLlamaCppModels('http://localhost:8080/v1')
  expect(lastHeaders?.['Authorization']).toBeUndefined()
})

test('failure path returns [] on network error', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as any
  const result = await fetchLlamaCppModels('http://localhost:8080/v1')
  expect(result).toEqual([])
})

test('non-200 returns []', async () => {
  mockFetch(() => new Response('nope', { status: 401 }))
  const result = await fetchLlamaCppModels('http://localhost:8080/v1', 'sk-bad')
  expect(result).toEqual([])
})

test('malformed JSON (no data key) returns []', async () => {
  mockFetch(() => new Response(JSON.stringify({}), { status: 200 }))
  const result = await fetchLlamaCppModels('http://localhost:8080/v1')
  expect(result).toEqual([])
})
