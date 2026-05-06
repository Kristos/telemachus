import { describe, expect, test } from 'bun:test'
import type { CliToolConfig } from '../config/types.js'
import type { TrustTier } from '../security/trust-tiers.js'
import { resolveSubCommandTier } from './resolve-tier.js'

const make = (
  subCommandTiers?: Record<string, TrustTier>,
  trustTier?: TrustTier,
): CliToolConfig => ({
  command: 'gh',
  description: 'GitHub CLI',
  trustTier,
  subCommandTiers,
})

describe('resolveSubCommandTier', () => {
  const cases: Array<{
    name: string
    argv: string[]
    config: CliToolConfig
    expected: TrustTier
  }> = [
    {
      name: 'exact single-element match',
      argv: ['pr'],
      config: make({ pr: 'safe' }),
      expected: 'safe',
    },
    {
      name: 'exact two-element match',
      argv: ['pr', 'list'],
      config: make({ 'pr list': 'safe' }),
      expected: 'safe',
    },
    {
      name: 'longest prefix wins over shorter',
      argv: ['pr', 'merge', '123'],
      config: make({ pr: 'safe', 'pr merge': 'dangerous' }),
      expected: 'dangerous',
    },
    {
      name: 'falls back to shorter prefix when longest misses',
      argv: ['pr', 'list', '--all'],
      config: make({ pr: 'safe' }),
      expected: 'safe',
    },
    {
      name: 'no match falls through to config default',
      argv: ['issue', 'close'],
      config: make({ pr: 'safe' }, 'risky'),
      expected: 'risky',
    },
    {
      name: 'no match + no default = dangerous (fail closed)',
      argv: ['issue', 'close'],
      config: make({ pr: 'safe' }),
      expected: 'dangerous',
    },
    {
      name: 'empty argv with default',
      argv: [],
      config: make({ pr: 'safe' }, 'risky'),
      expected: 'risky',
    },
    {
      name: 'empty argv without default = dangerous',
      argv: [],
      config: make({ pr: 'safe' }),
      expected: 'dangerous',
    },
    {
      name: 'no subCommandTiers at all = default',
      argv: ['pr', 'list'],
      config: make(undefined, 'safe'),
      expected: 'safe',
    },
    {
      name: 'no subCommandTiers and no default = dangerous',
      argv: ['pr', 'list'],
      config: make(undefined),
      expected: 'dangerous',
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveSubCommandTier(c.argv, c.config)).toBe(c.expected)
    })
  }
})
