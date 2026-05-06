import { test, expect, describe } from 'bun:test'
import {
  formatCost,
  formatMcp,
  formatMcpHelp,
  formatLastActivity,
  formatAgents,
  formatHooks,
  formatModel,
} from './format.js'
import type { ManagedServerView } from '../../mcp/manager.js'
import type { UsageSession } from '../../usage/tracker.js'
import type { HookConfig } from '../../hooks/types.js'

const emptySession: UsageSession = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  turnCount: 0,
  lastTurn: null,
  // Phase 64 (CACHE-04): cache token totals — 0 by default (non-Anthropic)
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
}

describe('formatCost', () => {
  test('empty session', () => {
    const out = formatCost(emptySession, 'claude-sonnet', 'anthropic', new Map(), null)
    expect(out).toBe('Session usage:\n  total: 0↑ 0↓  $0.0000\n  turns: 0')
  })

  test('single-model session shows breakdown', () => {
    const session: UsageSession = {
      totalInputTokens: 1200,
      totalOutputTokens: 340,
      totalCost: 0.0123,
      turnCount: 2,
      lastTurn: null,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    }
    const perModel = new Map([
      ['anthropic/claude-sonnet', { input: 1200, output: 340, cost: 0.0123 }],
    ])
    const out = formatCost(session, 'claude-sonnet', 'anthropic', perModel)
    expect(out).toContain('Session usage:')
    expect(out).toContain('total: 1200↑ 340↓  $0.0123')
    expect(out).toContain('turns: 2')
    expect(out).toContain('By model:')
    expect(out).toContain('  anthropic/claude-sonnet: 1200↑ 340↓  $0.0123')
  })

  test('multi-model session lists each', () => {
    const session: UsageSession = {
      totalInputTokens: 3000,
      totalOutputTokens: 500,
      totalCost: 0.05,
      turnCount: 4,
      lastTurn: null,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    }
    const perModel = new Map([
      ['anthropic/claude-sonnet', { input: 1000, output: 200, cost: 0.02 }],
      ['openai/gpt-4o', { input: 2000, output: 300, cost: 0.03 }],
    ])
    const out = formatCost(session, 'gpt-4o', 'openai', perModel)
    expect(out).toContain('  anthropic/claude-sonnet: 1000↑ 200↓  $0.0200')
    expect(out).toContain('  openai/gpt-4o: 2000↑ 300↓  $0.0300')
  })

  test('omits breakdown when perModel empty', () => {
    const out = formatCost(emptySession, 'm', 'p', new Map())
    expect(out).not.toContain('By model:')
  })

  test('renders tool schema breakdown with builtin + mcp servers', () => {
    const out = formatCost(emptySession, 'm', 'p', new Map(), {
      builtin: 1240,
      mcpByServer: { my_mcp: 1820, 'other-mcp': 950, another_mcp: 1100 },
      mcpTotal: 3870,
    })
    expect(out).toContain('Tool schemas (last turn):')
    expect(out).toContain('builtin: 1240 tok')
    expect(out).toContain('mcp:     3870 tok total')
    expect(out).toContain('mcp/my_mcp: 1820 tok')
    expect(out).toContain('mcp/other-mcp:  950 tok')
    expect(out).toContain('mcp/another_mcp: 1100 tok')
    expect(out).toContain('(schema tokens estimated via gpt-tokenizer; relative, not exact billing)')
  })

  test('omits mcp block entirely when mcpTotal is 0', () => {
    const out = formatCost(emptySession, 'm', 'p', new Map(), {
      builtin: 500,
      mcpByServer: {},
      mcpTotal: 0,
    })
    expect(out).toContain('builtin: 500 tok')
    expect(out).not.toContain('mcp:')
    expect(out).not.toContain('tok total')
  })

  test('omits tool schemas section entirely when schemaCost null', () => {
    const out = formatCost(emptySession, 'm', 'p', new Map(), null)
    expect(out).not.toContain('Tool schemas')
  })

  // Phase 64 (CACHE-04): /cost surfaces Anthropic prompt-cache totals when non-zero
  test('renders cache lines when totalCacheReadTokens > 0', () => {
    const session: UsageSession = {
      totalInputTokens: 22,
      totalOutputTokens: 10,
      totalCost: 0.0001,
      turnCount: 2,
      lastTurn: null,
      totalCacheReadTokens: 1215,
      totalCacheCreationTokens: 0,
    }
    const out = formatCost(session, 'claude-sonnet', 'anthropic', new Map())
    expect(out).toContain('cache reads: 1215 tokens')
    expect(out).toContain('cache creations: 0 tokens')
  })

  test('renders cache lines when totalCacheCreationTokens > 0 (first-call case)', () => {
    const session: UsageSession = {
      totalInputTokens: 22,
      totalOutputTokens: 10,
      totalCost: 0.0001,
      turnCount: 1,
      lastTurn: null,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 1215,
    }
    const out = formatCost(session, 'claude-sonnet', 'anthropic', new Map())
    expect(out).toContain('cache reads: 0 tokens')
    expect(out).toContain('cache creations: 1215 tokens')
  })

  test('omits cache lines when both cache totals are 0 (non-Anthropic baseline)', () => {
    const out = formatCost(emptySession, 'm', 'p', new Map())
    expect(out).not.toContain('cache reads:')
    expect(out).not.toContain('cache creations:')
  })
})

describe('formatLastActivity', () => {
  const NOW = 1_700_000_000_000
  test('null → em dash', () => {
    expect(formatLastActivity(null, NOW)).toBe('—')
  })
  test('just now', () => {
    expect(formatLastActivity(NOW - 500, NOW)).toBe('just now')
  })
  test('seconds ago', () => {
    expect(formatLastActivity(NOW - 30_000, NOW)).toBe('30s ago')
  })
  test('minutes ago', () => {
    expect(formatLastActivity(NOW - 3 * 60_000, NOW)).toBe('3m ago')
  })
  test('hours ago', () => {
    expect(formatLastActivity(NOW - 5 * 3_600_000, NOW)).toBe('5h ago')
  })
})

describe('formatMcp', () => {
  const NOW = 1_700_000_000_000

  test('empty array → config hint', () => {
    expect(formatMcp([])).toBe(
      'No MCP servers configured. Set `mcpServers` in ~/.telemachus/config.json.',
    )
  })

  test('all 5 statuses render as fenced table (snapshot)', () => {
    const views: ManagedServerView[] = [
      {
        name: 'fs',
        mode: 'eager',
        status: 'alive',
        lastActivity: NOW - 3 * 60_000,
        toolCount: 7,
        trustTier: 'dangerous',
      },
      {
        name: 'slow',
        mode: 'eager',
        status: 'idle',
        lastActivity: NOW - 2 * 3_600_000,
        toolCount: 3,
        trustTier: 'risky',
      },
      {
        name: 'search',
        mode: 'lazy',
        status: 'lazy',
        lastActivity: null,
        toolCount: 5,
        trustTier: 'dangerous',
      },
      {
        name: 'broken',
        mode: 'lazy',
        status: 'dead',
        lastActivity: NOW - 30_000,
        toolCount: 0,
        trustTier: 'dangerous',
      },
      {
        name: 'off',
        mode: 'eager',
        status: 'disabled',
        lastActivity: null,
        toolCount: 2,
        trustTier: 'safe',
      },
    ]
    const out = formatMcp(views, NOW)
    expect(out).toMatchSnapshot()
    // Sanity: fenced, header present, all rows present
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
    expect(out).toContain('NAME')
    expect(out).toContain('MODE')
    expect(out).toContain('STATUS')
    expect(out).toContain('LAST ACTIVITY')
    expect(out).toContain('TOOLS')
    expect(out).toContain('TRUST')
    expect(out).toContain('fs')
    expect(out).toContain('slow')
    expect(out).toContain('search')
    expect(out).toContain('broken')
    expect(out).toContain('off')
    expect(out).toContain('—') // null lastActivity
    expect(out).toContain('disabled')
    expect(out).toContain('lazy')
    // Fits within 80 cols
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
  })
})

describe('formatMcpHelp', () => {
  test('lists all subcommands', () => {
    const out = formatMcpHelp()
    expect(out).toContain('/mcp enable <name>')
    expect(out).toContain('/mcp disable <name>')
    expect(out).toContain('/mcp spawn <name>')
    expect(out).toContain('/mcp kill <name>')
  })
})

describe('formatAgents', () => {
  test('single type', () => {
    const out = formatAgents([
      { name: 'general-purpose', description: 'General agent for any task' },
    ])
    expect(out).toContain('Available subagent types (1):')
    expect(out).toContain('  • general-purpose — General agent for any task')
  })

  test('empty array', () => {
    expect(formatAgents([])).toBe('Available subagent types: none registered')
  })
})

describe('formatModel', () => {
  test('shows profile attribution when profile overrides provider', () => {
    const out = formatModel('llamacpp', 'glm-4.7-flash', 'local', true)
    expect(out).toBe('llamacpp / glm-4.7-flash [profile: local]')
  })

  test('no attribution when profileName is undefined', () => {
    const out = formatModel('anthropic', 'claude-sonnet-4-6', undefined)
    expect(out).toBe('anthropic / claude-sonnet-4-6')
  })

  test('no attribution when profile does not override provider', () => {
    const out = formatModel('anthropic', 'claude-sonnet-4-6', 'default-profile', false)
    expect(out).toBe('anthropic / claude-sonnet-4-6')
  })
})

describe('formatHooks', () => {
  test('undefined config', () => {
    expect(formatHooks(undefined)).toBe('Configured hooks: none configured')
  })

  test('empty config', () => {
    expect(formatHooks({})).toBe('Configured hooks: none configured')
  })

  test('PreToolUse with one matcher and two hooks', () => {
    const cfg: HookConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'echo a' },
            { type: 'command', command: 'echo b' },
          ],
        },
      ],
    }
    const out = formatHooks(cfg)
    expect(out).toContain('Configured hooks:')
    expect(out).toContain('  PreToolUse:')
    expect(out).toContain('    [Bash] echo a')
    expect(out).toContain('    [Bash] echo b')
  })

  test('all three events render in HOOK_EVENTS order', () => {
    const cfg: HookConfig = {
      Stop: [{ hooks: [{ type: 'command', command: 'stop-cmd' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'post-cmd' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'pre-cmd' }] }],
    }
    const out = formatHooks(cfg)
    const preIdx = out.indexOf('PreToolUse:')
    const postIdx = out.indexOf('PostToolUse:')
    const stopIdx = out.indexOf('Stop:')
    expect(preIdx).toBeGreaterThan(-1)
    expect(postIdx).toBeGreaterThan(preIdx)
    expect(stopIdx).toBeGreaterThan(postIdx)
    expect(out).toContain('    [*] pre-cmd')
    expect(out).toContain('    [Edit] post-cmd')
    expect(out).toContain('    [*] stop-cmd')
  })
})
