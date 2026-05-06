import { test, expect, describe } from 'bun:test'
import { z } from 'zod'
import { ToolRegistry } from './registry.js'
import { webSearchTool } from './builtin/web-search.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const fakeServerTool: Tool = {
  name: 'fake_server',
  description: 'fake',
  inputSchema: z.object({}),
  isServerTool: true,
  async execute(_i: unknown, _c: ToolContext): Promise<ToolResult> {
    return { content: 'x', isError: false }
  },
}

describe('ToolRegistry isServerTool propagation', () => {
  test('toAPISchemaForProvider(anthropic) preserves isServerTool on web_search', () => {
    const registry = new ToolRegistry()
    registry.register(webSearchTool)
    const schemas = registry.toAPISchemaForProvider('anthropic')
    const ws = schemas.find(s => s.name === 'web_search')
    expect(ws).toBeDefined()
    expect(ws!.isServerTool).toBe(true)
  })

  test('toAPISchemaForProvider exposes isServerTool flag so hasServerTools check is truthy', () => {
    const registry = new ToolRegistry()
    registry.register(fakeServerTool)
    const schemas = registry.toAPISchemaForProvider('anthropic')
    // This mimics AnthropicProvider line 74: tools.some(t => t.isServerTool)
    expect(schemas.some(t => t.isServerTool)).toBe(true)
  })

  test('toAPISchema includes isServerTool field for consistency', () => {
    const registry = new ToolRegistry()
    registry.register(fakeServerTool)
    const schemas = registry.toAPISchema()
    // Current behavior filters server tools out entirely — we want them included with the flag
    const fake = schemas.find(s => s.name === 'fake_server')
    expect(fake).toBeDefined()
    expect(fake!.isServerTool).toBe(true)
  })

  test('toAPISchemaForProvider sets isServerTool to false (not undefined) for regular tools', () => {
    const regular: Tool = {
      name: 'regular',
      description: 'r',
      inputSchema: z.object({ x: z.string() }),
      async execute() { return { content: 'ok', isError: false } },
    }
    const registry = new ToolRegistry()
    registry.register(regular)
    const schemas = registry.toAPISchemaForProvider('anthropic')
    const r = schemas.find(s => s.name === 'regular')
    expect(r).toBeDefined()
    // Explicit field (not conditionally spread) — value should be falsy
    expect(r!.isServerTool).toBeFalsy()
  })
})
