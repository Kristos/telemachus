/**
 * Phase 30 (SEC-10, SEC-11, SEC-12, CFG-01): Discord bot configuration.
 * Leaf module — no internal imports — so it can be consumed by
 * src/config/types.ts without creating import cycles.
 */
export interface DiscordConfig {
  /** Environment variable name holding the bot token. Never store the token itself. */
  tokenEnv: string
  /** Discord user IDs allowed to interact with the bot. */
  allowedUsers: string[]
  /** Guild ID for the bot (used for thread creation in Phase 31). */
  guildId?: string
  /** Profile name from KristosConfig.profiles to activate for Discord sessions (CFG-01). */
  profile?: string
  /**
   * Phase 33 (JOB-03): Discord channel ID where background job completion results
   * are posted. When absent, results are posted back to the channel where !run was
   * invoked (the originating channel acts as the results channel).
   */
  resultsChannelId?: string
  /**
   * Phase 35 (D-08): Per-model pricing for estimated cost display.
   * Keys are model names. Values are cost per 1M tokens (USD).
   */
  pricing?: Record<string, { input: number; output: number }>
  /**
   * Phase 35 (D-09): Hour (0-23 UTC) to send daily usage summary DM. Default 7.
   */
  usageHour?: number
  /**
   * Phase 56 (TRUNC-01): Max agent turns kept in per-channel conversation history.
   * Default 40 (~80 messages). Configurable when long-form channels need more context.
   */
  maxConversationTurns?: number
  /**
   * Phase 56 (BUDGET-01): Daily token quota per Discord user. Default 1_000_000.
   * When exceeded, the bot DMs the user with remaining budget + reset time
   * and refuses the turn until the next UTC midnight reset.
   * Zod validated: integer, min 1000, max 1_000_000_000.
   */
  dailyTokensPerUser?: number
  /**
   * Phase 37 (UPDATE-04): Webhook listener config for auto-update.
   * When present, `tm discord` starts a local HTTP server that receives
   * GitHub push webhooks and runs the build pipeline on push to main.
   */
  webhook?: {
    /** Environment variable name holding the GitHub webhook HMAC secret. */
    secretEnv: string
    /** Port for webhook HTTP server. Default 9876. */
    port?: number
    /** Branch to deploy from. Default 'refs/heads/main'. */
    branch?: string
  }
  /**
   * Phase 57 (STRIP-03): token threshold above which Layer A tool-result
   * stripping fires before addUserMessage. Default 40_000 when set,
   * stripping is skipped entirely when undefined or 0. Zod validated:
   * integer, min 1000 (configurable via KristosConfig.discord).
   */
  compressionThreshold?: number
  /**
   * Phase 57 (D-17, STRIP-02): number of trailing raw Message[] entries
   * preserved verbatim by stripToolResults. Default 4. NOT Discord
   * round-trip pairs — counts raw array entries. Zod validated: integer min 1.
   */
  compressionKeepTailTurns?: number
  /**
   * Phase 60 (DISPATCH-08): Layer C orchestration auto-dispatch.
   * Default-off — opt-in via config. When enabled, multi-step build
   * intents detected on Discord automatically route to runOrchestrateDiscord
   * after a cancellation window during which the user can type `!cancel`.
   * Zod validated: cancellationWindowMs bounds [1000, 30000], default 10000.
   * Invalid bounds drop the whole autoDispatch block (ops-safe default-off).
   */
  autoDispatch?: {
    enabled: boolean
    cancellationWindowMs?: number
  }
  /**
   * Phase 63 (OBS-03): Tool-error DM alert thresholds.
   *
   * When absent, defaults apply:
   *   - perToolThreshold: 3     (N failures in window → DM)
   *   - perToolWindowMs: 15*60_000 (15 minutes)
   *   - cooldownMs: 30*60_000   (30 minutes between DMs per tool)
   *   - tickIntervalMs: 60_000  (check every 60s)
   *
   * Setting perToolThreshold=0 disables the alert entirely.
   */
  toolErrorAlerts?: {
    perToolThreshold?: number
    perToolWindowMs?: number
    cooldownMs?: number
    tickIntervalMs?: number
  }
  /**
   * Phase 64 (PERS-01, BACKLOG 999.16): Per-channel persona block injected
   * into the system prompt for that channel. When absent for a given channel,
   * a default neutral-engineer persona (src/discord/persona.ts DEFAULT_PERSONA)
   * is used. Zod validated in loader: record keys non-empty strings, values
   * 1–4000 chars. Invalid shapes drop the whole personas map.
   */
  personas?: Record<string, string>
  /**
   * Phase 64 (PERS-02, BACKLOG 999.16 fix path 4): Per-channel emoji
   * suppression. When true for a channel, src/discord/persona.ts
   * assembleSystemPrompt appends "Reply in plain text; no emoji." to the
   * system prompt. Zod validated: map of non-empty-string keys to booleans;
   * invalid shape drops the whole field.
   */
  suppressEmoji?: Record<string, boolean>
}
