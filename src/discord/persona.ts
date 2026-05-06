/**
 * Phase 64 (PERS-01, PERS-03): Per-channel persona injection into Discord
 * system prompts. Pure helpers — no I/O, no side effects.
 *
 * Default persona is a neutral engineer tone to prevent auction-MCP hype
 * leakage into coding-help channels (origin: BACKLOG 999.16).
 *
 * Phase 64 plan 64-05 extends the config parameter shape with suppressEmoji
 * (PERS-02) — keep the signature open to structural extension.
 */

export const DEFAULT_PERSONA =
  'You are a focused software engineer. Reply with clear, direct technical answers.'

export function resolvePersona(
  channelId: string,
  config: { personas?: Record<string, string> } | undefined,
): string {
  const custom = config?.personas?.[channelId]
  if (typeof custom === 'string' && custom.length > 0) return custom
  return DEFAULT_PERSONA
}

export function assembleSystemPrompt(
  channelId: string,
  basePrompt: string,
  config: {
    personas?: Record<string, string>
    /**
     * Phase 64 (PERS-02): When true for this channel, appends
     * "Reply in plain text; no emoji." to the end of the assembled prompt.
     */
    suppressEmoji?: Record<string, boolean>
  } | undefined,
): string {
  const persona = resolvePersona(channelId, config)
  const emojiSuffix =
    config?.suppressEmoji?.[channelId] === true
      ? '\n\nReply in plain text; no emoji.'
      : ''
  if (basePrompt.length === 0) return `${persona}${emojiSuffix}`
  return `${basePrompt}\n\n${persona}${emojiSuffix}`
}
