/**
 * Phase 69: Telegram bot configuration.
 * Leaf module — no internal imports — so it can be consumed by
 * src/config/types.ts without creating import cycles.
 */
export interface TelegramConfig {
  /** Environment variable name holding the bot token. Never store the token itself. */
  tokenEnv: string
  /** Telegram user ID of the owner (as string). Also used as the DM chat ID. */
  ownerChatId: string
  /** Profile name from KristosConfig.profiles to activate (optional). */
  profile?: string
  /** Max conversation turns per chat (default: 40, matches Discord). */
  maxConversationTurns?: number
  /** Daily token quota per chat (default: 1_000_000). */
  dailyTokensPerUser?: number
  /** Future: webhook URL — activates webhook mode when present (Phase 72+). */
  webhookUrl?: string
  /** Future: webhook port (default 8443). */
  webhookPort?: number
}
