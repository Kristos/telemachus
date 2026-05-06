import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { formatCost } from '../../src/ui/slash/format.js'
import { createSession, recordSchemaCost, computeToolSchemaTokens } from '../../src/usage/tracker.js'
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

const tools: Tool[] = [
  makeTool('read', 'Read a file from disk'),
  makeTool('mcp__srvA__tinything', 'x'),
  makeTool('mcp__srvB__hugething', 'A much longer description field that will push this schema representation above the others for sorting verification purposes in the verbose output formatter test.'),
]

describe('formatCost verbose', () => {
  const session = createSession()
  const perModel = new Map()

  it('zero-arg output has no per-tool breakdown', () => {
    recordSchemaCost(computeToolSchemaTokens(tools))
    const out = formatCost(session, 'm', 'p', perModel)
    expect(out).not.toContain('Per-tool breakdown:')
  })

  it('verbose output contains per-tool breakdown sorted desc', () => {
    const cost = computeToolSchemaTokens(tools)
    const out = formatCost(session, 'm', 'p', perModel, cost, { verbose: true, tools })
    expect(out).toContain('Per-tool breakdown:')
    // Each tool name appears
    for (const t of tools) expect(out).toContain(t.name)
    // Sort order: find indices of tool names, verify descending token order
    const lines = out.split('\n')
    const perToolIdx = lines.findIndex((l) => l.includes('Per-tool breakdown:'))
    expect(perToolIdx).toBeGreaterThan(-1)
    const breakdownLines = lines.slice(perToolIdx + 1).filter((l) => /\btok\b/.test(l) && /mcp__|read/.test(l))
    // extract numbers
    const numbers = breakdownLines.map((l) => {
      const m = l.match(/(\d+)\s*tok/)
      return m ? parseInt(m[1]!, 10) : NaN
    })
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i - 1]).toBeGreaterThanOrEqual(numbers[i]!)
    }
  })

  it('verbose with empty tools does not render per-tool section', () => {
    const out = formatCost(session, 'm', 'p', perModel, null, { verbose: true, tools: [] })
    expect(out).not.toContain('Per-tool breakdown:')
  })

  it('verbose without tools (undefined) does not render per-tool section', () => {
    const out = formatCost(session, 'm', 'p', perModel, null, { verbose: true })
    expect(out).not.toContain('Per-tool breakdown:')
  })
})
