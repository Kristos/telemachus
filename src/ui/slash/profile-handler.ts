/**
 * Phase 19 (LEAN-01): pure-ish handler for the /profile slash command.
 *
 * Factored out of app.tsx so it can be tested without rendering Ink. The
 * App component only has to: (1) read the returned message and push it as
 * an assistant reply, and (2) update its local `activeProfile` state.
 *
 * Never writes to config.json — session-only, matching /mcp's behavior.
 */

import type { KristosConfig } from '../../config/types.js'
import { PROFILE_RESET_TOKENS, resolveActiveProfile, resolveEffectiveProvider } from '../../config/profile.js'
import { createProvider } from '../../providers/registry.js'
import type { Provider } from '../../providers/types.js'
import { formatProfile } from './format.js'

interface McpManagerLike {
  reloadForProfile(originalConfig: KristosConfig, name: string | undefined): Promise<void>
}

export interface ProfileSlashResult {
  /** Assistant-message content to push into the chat. */
  message: string
  /** The new active profile name the caller should store in state. */
  newActiveProfile: string | undefined
  /** When the provider changed, contains the new provider + metadata for App state. */
  providerUpdate?: {
    provider: Provider
    providerKey: string
    model: string
    profileOverridesProvider: boolean
  }
}

/**
 * Handle `/profile <arg>`.
 *
 * - `arg === ''`  → list profiles, do not switch
 * - `arg` in {default, reset} → reload with undefined (back to config default)
 * - otherwise     → reload with the named profile
 *
 * On reload failure, returns a message containing the error and preserves
 * the previous activeProfile.
 */
export async function handleProfileSlash(
  arg: string,
  originalConfig: KristosConfig,
  currentActive: string | undefined,
  mcpManager: McpManagerLike,
): Promise<ProfileSlashResult> {
  const trimmed = arg.trim()

  // No arg → list
  if (trimmed === '') {
    return {
      message: formatProfile(originalConfig.profiles, currentActive),
      newActiveProfile: currentActive,
    }
  }

  // Reset tokens map to undefined, which reloadForProfile interprets as
  // "fall back to config.activeProfile".
  const target: string | undefined = PROFILE_RESET_TOKENS.has(trimmed) ? undefined : trimmed

  try {
    await mcpManager.reloadForProfile(originalConfig, target)
    // Re-derive what's actually active after the switch (respects config default).
    const newActive = resolveActiveProfile(originalConfig, target, undefined)
    const label = newActive ?? '(config default — no profile)'

    const effective = resolveEffectiveProvider(originalConfig, newActive)
    const effectiveConfig: KristosConfig = {
      ...originalConfig,
      provider: effective.provider,
      model: effective.model,
    }
    const newProvider = createProvider(effectiveConfig)
    const profileOverridesProvider =
      newActive !== undefined &&
      originalConfig.profiles?.[newActive]?.provider !== undefined &&
      originalConfig.profiles[newActive].provider !== originalConfig.provider

    return {
      message: `[profile switched] active: ${label}`,
      newActiveProfile: newActive,
      providerUpdate: {
        provider: newProvider,
        providerKey: effective.provider as string,
        model: effective.model,
        profileOverridesProvider,
      },
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      message: `[profile switch failed] ${errMsg}`,
      newActiveProfile: currentActive,
    }
  }
}
