import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import {
  computePerToolSchemaTokens,
  computeToolSchemaTokens,
} from '../../src/usage/tracker.js'
import type { Tool } from '../../src/tools/types.js'

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: z.object({ x: z.string() }),
    rawInputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    execute: async () => ({ content: '', isError: false }),
  }
}

describe('computePerToolSchemaTokens', () => {
  const tools: Tool[] = [
    makeTool('read', 'Read a file from disk'),
    makeTool('mcp__serverA__ping', 'Ping server A'),
    makeTool('mcp__serverA__pong', 'Pong server A'),
    makeTool('mcp__serverB__hello', 'Say hi from server B'),
  ]

  it('returns one entry per tool with correct group', () => {
    const entries = computePerToolSchemaTokens(tools)
    expect(entries).toHaveLength(4)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('read')?.group).toBe('builtin')
    expect(byName.get('mcp__serverA__ping')?.group).toBe('mcp/serverA')
    expect(byName.get('mcp__serverA__pong')?.group).toBe('mcp/serverA')
    expect(byName.get('mcp__serverB__hello')?.group).toBe('mcp/serverB')
  })

  it('token counts are positive integers', () => {
    const entries = computePerToolSchemaTokens(tools)
    for (const e of entries) {
      expect(Number.isInteger(e.tokens)).toBe(true)
      expect(e.tokens).toBeGreaterThan(0)
    }
  })

  it('sum of per-tool tokens equals computeToolSchemaTokens totals', () => {
    const entries = computePerToolSchemaTokens(tools)
    const sum = entries.reduce((a, e) => a + e.tokens, 0)
    const agg = computeToolSchemaTokens(tools)
    expect(sum).toBe(agg.builtin + agg.mcpTotal)
  })

  it('matches per-server totals from computeToolSchemaTokens', () => {
    const entries = computePerToolSchemaTokens(tools)
    const agg = computeToolSchemaTokens(tools)
    const serverA = entries
      .filter((e) => e.group === 'mcp/serverA')
      .reduce((a, e) => a + e.tokens, 0)
    const serverB = entries
      .filter((e) => e.group === 'mcp/serverB')
      .reduce((a, e) => a + e.tokens, 0)
    const builtin = entries
      .filter((e) => e.group === 'builtin')
      .reduce((a, e) => a + e.tokens, 0)
    expect(builtin).toBe(agg.builtin)
    expect(serverA).toBe(agg.mcpByServer.serverA)
    expect(serverB).toBe(agg.mcpByServer.serverB)
  })

  it('handles empty input', () => {
    expect(computePerToolSchemaTokens([])).toEqual([])
  })
})
