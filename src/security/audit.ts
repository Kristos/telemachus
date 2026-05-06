import { open, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { TrustTier } from './trust-tiers.js'
import type { PermissionMode } from '../permissions/types.js'

// NOTE: audit is observability, not enforcement. It records what happened so
// the owner can review tool calls after the fact. It does NOT gate or deny —
// that's checkPermission's job. Append failures must never crash the agent:
// a failing disk is not a reason to refuse tool calls. Errors go to stderr
// only, and the tool call proceeds.

export type SandboxStatus = 'enforced' | 'bypassed' | 'unavailable' | 'n/a'

export type AuditKind =
  | 'tool_call'
  | 'mcp_sandbox_warning'
  | 'mcp_spawn'
  | 'mcp_kill'
  | 'mcp_disable'
  | 'mcp_idle_kill'
  | 'discord_turn'
  | 'provider_switch'
  | 'dependency_validation'
  | 'wave_fail_fast'
  | 'git_deploy'
  | 'circuit_state_change'
  | 'provider_queue_wait'
  | 'compression_fired'  // Phase 57 (STRIP-04): Layer A tool-result stripping event
  | 'router_decision'   // Phase 59 (ROUTE-05): per-turn routing decision
  | 'router_escalation' // Phase 59 (ROUTE-04): fail-open to complex
  | 'auto_dispatched'         // Phase 60 (DISPATCH-09): Layer C auto-dispatch fired
  | 'auto_dispatch_refused'   // Phase 60 (DISPATCH-04): auto-dispatch refused (budget/cooldown/pending/complexity_gate)
  | 'router_classifier_paused' // Phase 61 (COST-05): router-level circuit breaker paused the classifier path
  | 'sandbox_probe' // Phase 62 (SAND-02): startup HOME/CWD allowlist probe
  | 'tool_error' // Phase 63 (OBS-01): tool execution failure — additive to tool_call exitCode:1
  | 'blast_radius_exceeded' // Phase 66 (BLAST-02): worker diff exceeded blastRadiusThreshold pre-merge

// Phase 26 narrow shapes (D-17):
//   mcp_spawn:     { kind, ts, sessionId, platform, server, pid: number | null, tier, sandbox: 'enforced' | 'unavailable' }
//   mcp_kill:      { kind, ts, sessionId, platform, server, pid: number | null, tier, reason: 'user' }
//   mcp_idle_kill: { kind, ts, sessionId, platform, server, pid: number | null, tier, idle_duration_ms: number }
//   mcp_disable:   { kind, ts, sessionId, platform, server, previous_tier, was_alive: boolean, pid: number | null }
//
// Flat shape with kind discriminator (D-12). Phase 25 ships all kinds;
// Phase 26 wires the remaining call sites.
// kind is the second field after ts for grep-ability. tool_call fields are
// optional so lifecycle rows (mcp_spawn, mcp_kill, etc.) need not populate them.
export interface AuditEntry {
  ts: string            // ISO 8601 UTC
  kind: AuditKind       // discriminator — second field after ts (D-12)
  sessionId: string
  platform: string      // always present (process.platform)
  // tool_call fields (existing shape preserved, now optional):
  tool?: string
  tier?: TrustTier
  argsHash?: string     // 'sha256:' + hex
  resultSize?: number   // bytes of result.content
  durationMs?: number
  mode?: PermissionMode
  exitCode?: number     // 0 on success, 1 on isError
  sandbox?: SandboxStatus
  // lifecycle fields (Phase 25 writes mcp_sandbox_warning; rest reserved for Phase 26):
  server?: string
  pid?: number | null   // widened from number: lifecycle rows carry null when extraction fails (D-04)
  previous_tier?: TrustTier
  idle_duration_ms?: number
  reason?: string
  was_alive?: boolean   // mcp_disable only: was the server alive at disable time (D-17)
  // Phase 31 (SEC-13): Discord source attribution — optional so non-Discord
  // entries (interactive CLI, agent-runner) remain unchanged.
  source?: 'discord'        // origin surface that triggered the tool call
  discordUserId?: string    // Discord snowflake of the user who sent the message
  discordChannelId?: string // Discord channel/thread ID where the message originated
  // Phase 45 (FALL-01..03): provider_switch audit fields
  primaryProvider?: string  // Name of the primary provider that failed
  fallbackProvider?: string // Name of the fallback provider used
  triggerCode?: number      // HTTP status code that triggered the switch (429, 529, etc.)
  retryAttempts?: number    // Number of retries attempted before switching
  // Phase 52 (DEP-01..03): dependency_validation audit fields
  taskCount?: number          // total tasks in the plan that was validated
  flagCount?: number          // number of flagged dependency edges
  trigger?: 'success' | 'llm_error' | 'parse_error' | 'timeout'  // outcome of the validator call
  validatorModel?: string     // model name used for the validator call
  // Phase 53 (WAVE-01..04): wave_fail_fast audit fields
  waveNumber?: number              // 1-based wave number that triggered the gate
  rate?: number                    // calculated failure rate (0..1) for that wave
  threshold?: number               // threshold the rate met or exceeded
  /** Phase 53 wave_fail_fast: continue|abort|no_callback. Phase 59 router_decision: simple|complex (legacy). Phase 74: IntentClass. */
  decision?: 'continue' | 'abort' | 'no_callback' | 'simple' | 'complex' | import('../config/types.js').IntentClass
  // git_deploy audit fields — one entry per tool invocation regardless of outcome
  outcome?:
    | 'rejected'
    | 'prompt_error'
    | 'checkout_failed'
    | 'commit_failed'
    | 'push_failed'
    | 'pr_create_failed'
    | 'pushed_to_main'
    | 'success'
  branch?: string                  // target branch name
  commitHash?: string              // short hash produced by the commit step (8 chars)
  prUrl?: string                   // PR URL on success
  error?: string                   // short error message on any failure path
  // circuit_state_change audit fields — emitted by FallbackProvider on
  // any breaker transition (closed→open, half_open→closed, half_open→open)
  circuitProvider?: string         // provider.name whose circuit changed
  circuitFromState?: string        // closed | open | half_open
  circuitToState?: string          // closed | open | half_open
  circuitReason?:
    | 'threshold_reached'
    | 'probe_failed'
    | 'probe_succeeded'
    | 'recovered'
  consecutiveFailures?: number     // counter value AT transition time
  // Phase 55 (CONC-02): provider_queue_wait audit fields — emitted by
  // LLMSemaphore when a waiter blocks > 500ms.
  waitMs?: number
  queueDepth?: number
  providerName?: string
  // Phase 57 (MEAS-01, STRIP-04): cross-event correlation key shared with
  // TurnSummaryRecord and (future) router_decision/auto_dispatched events.
  turnId?: string
  // Phase 57 (STRIP-04): compression_fired event fields.
  // compression_fired shape: { kind, ts, sessionId, platform, turnId, channelId,
  //   tokensBefore: number, tokensAfter: number, turnsStripped: number, strategy: 'tool_strip' }
  tokensBefore?: number
  tokensAfter?: number
  turnsStripped?: number
  /** 'tool_strip' for Phase 57 Layer A; 'llm_compress' reserved for Phase 58. */
  strategy?: 'tool_strip' | 'llm_compress'
  // Phase 59 (ROUTE-05, D-04): 'router_decision' / 'router_escalation' fields.
  // 'router_decision' shape: { kind, ts, sessionId, platform, turnId, channelId,
  //   decision: 'simple' | 'complex', fastPath: boolean, classifierTokens: number,
  //   latencyMs: number, wasCompressed: boolean }
  // 'router_escalation' shape: { kind, ts, sessionId, platform, turnId, channelId,
  //   reason: 'classifier_error' | 'classifier_timeout' | 'invalid_output',
  //   classifierRawResponse?: string (≤500 chars, only on reason: 'invalid_output') }
  // turnId, channelId, reason, decision already declared above — only new fields here.
  classifierTokens?: number
  latencyMs?: number
  fastPath?: boolean
  wasCompressed?: boolean
  /**
   * Phase 59.1 (FIX-ROUTER-01, D-03): Raw classifier response text captured
   * when router_escalation fires with reason: 'invalid_output'. Truncated to
   * ≤500 chars with ellipsis suffix if original exceeds 500. Absent on
   * classifier_error and classifier_timeout reasons (those carry err.message
   * via the log() call). Optional — backward-compatible on parse.
   */
  classifierRawResponse?: string
  /**
   * Phase 60 (DISPATCH-09 / DISPATCH-04): cross-event correlation fields
   * for Layer C auto-dispatch. channelId + userId enable per-channel /
   * per-user quota enforcement lookups in future phases. Already referenced
   * by compression_fired / router_decision shape comments above — formalized
   * as declared optional fields here.
   */
  channelId?: string
  userId?: string
  /** Phase 60 (DISPATCH-09): first 50 chars of user message content for auto_dispatched / auto_dispatch_refused rows. */
  contentSnippet?: string
  /** Phase 60 (DISPATCH-09 / DISPATCH-04): keyword pattern ids + complexity signal ids that triggered (or failed) dispatch. */
  signalsMatched?: string[]
  /** Phase 60 (DISPATCH-04): discriminant for auto_dispatch_refused rows. */
  dispatchReason?: 'budget_exceeded' | 'cooldown' | 'pending' | 'complexity_gate' | 'disabled' | 'no_keyword'
  // ─────────────────────────────────────────────────────────────────────────
  // Phase 61 (COST-05): router_classifier_paused fields.
  //
  // Emitted when the per-RouterProvider-instance circuit breaker transitions
  // from closed→open (escalation_threshold) or half_open→open (probe_failed).
  // consecutiveEscalations + cooldownMs let operators grep for sustained
  // rate-limit windows. Shape mirrors Phase 45 'provider_switch' precedent.
  //
  // Fields:
  //   - classifierPauseReason: discriminant for the transition cause
  //   - consecutiveEscalations: count at transition time (0-indexed from window)
  //   - cooldownMs: current cooldown duration (doubles on each half_open→open)
  //   - classifierName: sub-provider name, e.g. "openai-compat→llamacpp" when
  //     FallbackProvider-wrapped per Plan 61-03 COST-04
  //
  // turnId + discordChannelId are already declared above and present on this
  // kind when the transition fires during a specific Discord turn.
  // ─────────────────────────────────────────────────────────────────────────
  classifierPauseReason?: 'escalation_threshold' | 'probe_failed'
  consecutiveEscalations?: number
  cooldownMs?: number
  classifierName?: string
  // ─────────────────────────────────────────────────────────────────────────
  // Phase 62 (SAND-02): sandbox_probe fields.
  //
  // Emitted by src/security/sandbox-probe.ts before any tool dispatches in a
  // subagent. outcome reuses the existing git_deploy field domain (now
  // extended to 'pass' | 'fail' for sandbox_probe rows). home + cwd are
  // captured verbatim so operators can cross-reference HOME stripping or
  // CWD drift against ~/.telemachus session JSONL; projectRoot is the
  // resolved allowlist anchor (via KC_PROJECT_ROOT, .git walk-up,
  // .telemachus walk-up, or home-fallback).
  // ─────────────────────────────────────────────────────────────────────────
  home?: string
  cwd?: string
  projectRoot?: string
  // ─────────────────────────────────────────────────────────────────────────
  // Phase 63 (OBS-01): tool_error fields.
  //
  // Emitted by src/agent/loop.ts whenever a tool execution fails — either
  // because the tool threw (caught by the loop's try/catch) or because the
  // tool handler returned {isError:true}. The existing `tool_call` row still
  // fires with exitCode:1; `tool_error` is ADDITIVE — one extra row per
  // failure carrying the normalised error class + message so downstream
  // observability (OBS-02 rolling metric, OBS-03 DM alert, OBS-04 daily
  // summary, OBS-05 !tool-errors command) can group by `errorClass` without
  // re-parsing tool_call content.
  //
  // tool_error shape: { kind:'tool_error', ts, sessionId, platform, tool,
  //   errorClass, errorMessage, turnId?, channelId?, source?, discordUserId?,
  //   discordChannelId? }
  //
  // errorClass values produced by src/security/error-classifier.ts:
  //   - Node fs/Bun codes: 'EROFS', 'EBADF', 'ENOENT', ...
  //   - 'HTTPError' (status/statusCode present)
  //   - 'Timeout' (name or message match)
  //   - Custom error names: 'APIError', 'ZodError', ...
  //   - 'Error' (plain Error instance, no code/name)
  //   - 'Unknown' (string throws, null/undefined, unclassifiable)
  //
  // errorMessage: ≤500 chars, '…' suffix when truncated.
  //
  // Audit emission is best-effort — `.catch(()=>{})` at the call site so an
  // audit write failure never crashes the agent loop.
  // ─────────────────────────────────────────────────────────────────────────
  errorClass?: string
  errorMessage?: string
  // ─────────────────────────────────────────────────────────────────────────
  // Phase 66 (BLAST-02): blast_radius_exceeded fields.
  //
  // Emitted by src/orchestration/engine.ts before any merge attempt when the
  // worker's diff (counted via `git diff --name-only HEAD..<branch>`) touches
  // more than OrchestrationRunConfig.blastRadiusThreshold files. Task is
  // transitioned reviewing → escalated instead of reviewing → approved, and
  // the worker branch is left on disk for human inspection. Mirrors the
  // wave_fail_fast precedent: emit audit best-effort (`void append…`), never
  // block the transition on an audit write failure.
  //
  // blast_radius_exceeded shape: { kind, ts, sessionId, platform, taskId,
  //   branch: string, fileCount: number, threshold: number }
  //
  // sessionId carries the orchestration runId; taskId is the specific task
  // whose worker tripped the gate. branch + threshold are already declared
  // above; fileCount + taskId are added here.
  // ─────────────────────────────────────────────────────────────────────────
  taskId?: string
  fileCount?: number
}

export function auditDir(): string {
  // Use process.env.HOME when available so tests can redirect writes
  // to a temp directory without touching ~/.telemachus.
  const home = process.env.HOME ?? homedir()
  return join(home, '.telemachus', 'audit')
}

export function auditPath(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD UTC
  return join(auditDir(), `${date}.jsonl`)
}

export function hashArgs(args: unknown): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(args) ?? 'undefined').digest('hex')
}

/**
 * Parse a single JSONL audit line into an AuditEntry.
 * Backward-compat (D-14): rows written before kind was introduced
 * (v1.3-era and earlier) have no `kind` field; they default to 'tool_call'.
 */
export function parseAuditLine(line: string): AuditEntry {
  const parsed = JSON.parse(line) as Record<string, unknown>
  if (!('kind' in parsed)) {
    parsed['kind'] = 'tool_call'
  }
  return parsed as unknown as AuditEntry
}

export async function appendAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await mkdir(auditDir(), { recursive: true })
    const line = JSON.stringify(entry) + '\n'
    const fh = await open(auditPath(), 'a')
    try {
      await fh.appendFile(line, 'utf8')
      await fh.datasync()
    } finally {
      await fh.close()
    }
  } catch (err) {
    process.stderr.write(
      `[audit] warn: could not append entry: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    // Never crash the agent — audit is best-effort.
  }
}
