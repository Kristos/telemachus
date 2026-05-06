/**
 * Phase 70 (TGAGENT-03): HTML escape for outgoing Telegram messages.
 *
 * Telegram Bot API HTML parse mode requires only three characters to be
 * escaped: '&', '<', '>'. Order matters — '&' MUST be replaced first
 * to avoid double-escaping the entity references introduced by the
 * subsequent replacements (e.g. naive '<'→'&lt;' followed by '&'→'&amp;'
 * yields '&amp;lt;' which renders as literal '&lt;' in the chat).
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
