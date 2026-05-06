/**
 * Phase 37-01 (UPDATE-01, UPDATE-02, UPDATE-03): Webhook types for auto-update service.
 *
 * WebhookConfig is baked into the launchd plist at install time (Phase 37-02).
 * PipelineResult is the value returned by runBuildPipeline.
 */

export interface WebhookConfig {
  /** HMAC-SHA256 secret shared with GitHub */
  webhookSecret: string
  /** Port to listen on. Default 9876. */
  port: number
  /** Branch ref to accept. Default 'refs/heads/main'. */
  targetRef: string
  /** Absolute path to the repo root on the MacBook Pro. Baked into plist at install time. */
  repoDir: string
  /** Discord bot token env var name — for DM-on-failure via REST API */
  discordTokenEnv: string
  /** Discord owner user ID — for DM-on-failure */
  ownerId: string
}

export interface PipelineResult {
  success: boolean
  steps: Array<{ name: string; exitCode: number; durationMs: number; timedOut?: boolean }>
  logFile: string
  error?: string
}
