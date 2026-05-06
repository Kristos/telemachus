import type { CliToolConfig } from '../config/types.js'
import type { TrustTier } from '../security/trust-tiers.js'

/**
 * Phase 20 (LEAN-02), decision 10: longest-prefix-first sub-command tier
 * resolution with fail-closed default.
 *
 * For argv `['pr', 'merge', '123']` and a `subCommandTiers` map, this tries
 * keys `"pr merge 123"`, `"pr merge"`, `"pr"` in that order. First hit wins.
 * Falls through to `config.trustTier ?? 'dangerous'` (decision 10: fail closed).
 */
export function resolveSubCommandTier(
  argv: string[],
  config: CliToolConfig,
): TrustTier {
  const map = config.subCommandTiers
  if (map) {
    for (let i = argv.length; i > 0; i--) {
      const key = argv.slice(0, i).join(' ')
      const tier = map[key]
      if (tier) return tier
    }
  }
  return config.trustTier ?? 'dangerous'
}
