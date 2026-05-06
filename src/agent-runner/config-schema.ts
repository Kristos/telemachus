/**
 * Phase 22 (AGENT-01): headless agent job declaration shape.
 *
 * A KristosConfig may declare zero or more named agent jobs under
 * `agents: Record<string, AgentJobConfig>`. This module is intentionally a
 * leaf — no imports — so it can be consumed by both `src/config/types.ts`
 * and the Wave-2 runner module without creating a cycle.
 *
 * Decision 6 from Phase 22 research: `permissionMode` for agent jobs is
 * narrowed to `'yolo' | 'agent'`. Other modes (`ask`, `readonly`, `plan`)
 * are interactive-only and have no meaning in a headless run.
 */
export interface AgentJobConfig {
  /** Free-form natural-language task the agent will execute. Required. */
  prompt: string
  /** Optional provider override (falls back to top-level KristosConfig.provider). */
  provider?: 'anthropic' | 'openai-compat' | 'llamacpp'
  /** Optional model override. */
  model?: string
  /** Optional named profile from KristosConfig.profiles. */
  profile?: string
  /**
   * Headless jobs only get 'yolo' (fully automatic) or 'agent' (like yolo but
   * audit-tagged). Interactive modes are not meaningful without a human.
   */
  permissionMode?: 'yolo' | 'agent'
  /** Hard cap: stop after N loop iterations. */
  maxIterations?: number
  /** Hard cap: stop after N milliseconds of wall-clock time. */
  maxWallClockMs?: number
  /** Hard cap: stop after N accumulated input+output tokens. */
  maxTotalTokens?: number
  /**
   * Reserved for Phase 22 Wave 3: cron-style schedule string. Typed now so
   * config files round-trip forward-compatibly; not honored in Wave 1.
   */
  schedule?: string
  /**
   * Output channel. Defaults to file-only artifact writing. When set to a
   * webhook, the run-job orchestrator POSTs the result to the configured URL
   * after artifacts are written — best-effort, never blocks exit.
   * (Phase 23 Plan 2, AGENT-05.)
   */
  output?:
    | { type: 'file' }
    | {
        type: 'webhook'
        url: string
        format: 'slack' | 'discord' | 'ntfy' | 'raw'
      }
}
