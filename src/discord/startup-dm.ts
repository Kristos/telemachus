/**
 * Phase 36 (UPDATE-06): Startup notification DM builder.
 *
 * Pure function — builds the startup DM text from version/commit/timestamp/health info.
 * Called in bot.ts ClientReady handler via the onStartup callback.
 */

export interface StartupDmInfo {
  version: string
  commitHash: string
  timestamp: string   // ISO 8601
  llmHealth: { ok: boolean; error?: string }
}

/**
 * Build the startup notification DM text.
 *
 * Format:
 * ```
 * **KC restarted**
 * Version: {version} ({commitHash first 7 chars})
 * Time: {timestamp}
 * LLM: OK  OR  LLM: unreachable ({error})
 * ```
 */
export function buildStartupDm(info: StartupDmInfo): string {
  const shortHash = info.commitHash.slice(0, 7)
  const llmLine = info.llmHealth.ok
    ? 'LLM: OK'
    : `LLM: unreachable (${info.llmHealth.error ?? 'unknown'})`

  return [
    '**Telemachus restarted**',
    `Version: tm v${info.version} (${shortHash})`,
    `Time: ${info.timestamp}`,
    llmLine,
  ].join('\n')
}
