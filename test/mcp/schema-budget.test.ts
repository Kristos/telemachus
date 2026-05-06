import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { checkSchemaBudget, formatBudgetWarning } from '../../src/mcp/schema-budget.js'
import type { Tool } from '../../src/tools/types.js'

function tool(name: string, descLen: number): Tool {
  return {
    name,
    description: 'x'.repeat(descLen),
    inputSchema: z.object({ x: z.string() }),
    rawInputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    execute: async () => ({ content: '', isError: false }),
  }
}

describe('checkSchemaBudget', () => {
  it('returns offenders sorted desc by tokens', () => {
    const tools = [
      tool('small', 10),
      tool('huge', 4000),
      tool('medium', 1000),
    ]
    const offenders = checkSchemaBudget(tools, 50)
    expect(offenders.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < offenders.length; i++) {
      expect(offenders[i - 1]!.tokens).toBeGreaterThanOrEqual(offenders[i]!.tokens)
    }
    // small should not appear
    expect(offenders.find((o) => o.name === 'small')).toBeUndefined()
  })

  it('empty tools returns empty array', () => {
    expect(checkSchemaBudget([], 200)).toEqual([])
  })

  it('never throws on undefined rawInputSchema', () => {
    const t: Tool = {
      name: 'weird',
      description: 'x'.repeat(3000),
      inputSchema: z.object({}),
      execute: async () => ({ content: '', isError: false }),
    }
    expect(() => checkSchemaBudget([t], 50)).not.toThrow()
  })

  it('none exceed budget → empty', () => {
    expect(checkSchemaBudget([tool('s', 5)], 99999)).toEqual([])
  })
})

describe('formatBudgetWarning', () => {
  it('formats exactly per spec', () => {
    const out = formatBudgetWarning(
      [
        { name: 'alpha', tokens: 265 },
        { name: 'beta', tokens: 263 },
        { name: 'gamma', tokens: 247 },
      ],
      200,
    )
    expect(out).toBe(
      '[schema-budget] 3 tool(s) exceed 200 tok: alpha (265), beta (263), gamma (247)',
    )
  })

  it('empty offenders returns empty string', () => {
    expect(formatBudgetWarning([], 200)).toBe('')
  })

  it('singular tool count grammar still uses "tool(s)" literal', () => {
    const out = formatBudgetWarning([{ name: 'only', tokens: 500 }], 200)
    expect(out).toBe('[schema-budget] 1 tool(s) exceed 200 tok: only (500)')
  })
})
