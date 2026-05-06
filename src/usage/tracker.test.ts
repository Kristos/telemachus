import { test, expect, describe, beforeEach } from 'bun:test'
import { z } from 'zod'
import {
  computeToolSchemaTokens,
  recordSchemaCost,
  getLatestSchemaCost,
  resetLatestSchemaCost,
} from './tracker.js'
import type { Tool } from '../tools/types.js'

function builtinTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: z.object({ path: z.string() }),
    async execute() {
      return { content: '', isError: false }
    },
  }
}

function mcpTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: z.unknown(),
    rawInputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    async execute() {
      return { content: '', isError: false }
    },
  }
}

describe('computeToolSchemaTokens', () => {
  test('empty tool list yields zeros', () => {
    const cost = computeToolSchemaTokens([])
    expect(cost).toEqual({ builtin: 0, mcpByServer: {}, mcpTotal: 0 })
  })

  test('schema tokens builtin only', () => {
    const cost = computeToolSchemaTokens([
      builtinTool('read', 'read a file from disk'),
      builtinTool('write', 'write content to a file'),
    ])
    expect(cost.builtin).toBeGreaterThan(0)
    expect(cost.mcpByServer).toEqual({})
    expect(cost.mcpTotal).toBe(0)
  })

  test('schema tokens mcp split across different servers', () => {
    const cost = computeToolSchemaTokens([
      builtinTool('read', 'read a file'),
      mcpTool('mcp__foo__search', 'foo search tool'),
      mcpTool('mcp__bar__list', 'bar list tool'),
    ])
    expect(cost.builtin).toBeGreaterThan(0)
    expect(Object.keys(cost.mcpByServer).sort()).toEqual(['bar', 'foo'])
    expect(cost.mcpByServer.foo).toBeGreaterThan(0)
    expect(cost.mcpByServer.bar).toBeGreaterThan(0)
    expect(cost.mcpTotal).toBe(cost.mcpByServer.foo! + cost.mcpByServer.bar!)
  })

  test('schema tokens same server multiple tools accumulate', () => {
    const cost = computeToolSchemaTokens([
      mcpTool('mcp__foo__search', 'foo search tool'),
      mcpTool('mcp__foo__fetch', 'foo fetch tool'),
    ])
    expect(cost.builtin).toBe(0)
    expect(Object.keys(cost.mcpByServer)).toEqual(['foo'])
    expect(cost.mcpByServer.foo).toBeGreaterThan(0)
    expect(cost.mcpTotal).toBe(cost.mcpByServer.foo!)
  })
})

describe('latest schema cost module state', () => {
  beforeEach(() => {
    resetLatestSchemaCost()
  })

  test('starts null and can be recorded + read', () => {
    expect(getLatestSchemaCost()).toBeNull()
    recordSchemaCost({ builtin: 100, mcpByServer: { foo: 50 }, mcpTotal: 50 })
    expect(getLatestSchemaCost()).toEqual({
      builtin: 100,
      mcpByServer: { foo: 50 },
      mcpTotal: 50,
    })
  })

  test('reset clears the stored cost', () => {
    recordSchemaCost({ builtin: 10, mcpByServer: {}, mcpTotal: 0 })
    resetLatestSchemaCost()
    expect(getLatestSchemaCost()).toBeNull()
  })
})
