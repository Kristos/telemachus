/**
 * Phase 60 — Layer C orchestration auto-dispatch intent detection.
 *
 * This file ships in 3 stages:
 *   - 60-01: types + KEYWORD_PATTERNS constant only (shipped)
 *   - 60-03 (this commit): maybeAutoDispatch + computeComplexitySignals +
 *     isAtBudgetThreshold + matchKeywordPattern
 *   - 60-04: integration via runner.ts
 *
 * Default-off per DISPATCH-08; runtime behavior gated by DiscordConfig.autoDispatch.enabled.
 * Per CLAUDE.md: immutability (patterns are a const array, frozen shape). All helper
 * functions are pure (except maybeAutoDispatch, which reads mutable state from
 * ./auto-dispatch-state and emits best-effort audit events).
 */

import { appendAuditEntry } from '../security/audit.js'
import { checkCooldown, hasPendingDispatch } from './auto-dispatch-state.js'
import type { DiscordConfig } from './config.js'
import type { DiscordTokenBudget } from './token-budget.js'

export type KeywordPattern = { id: string; re: RegExp }

/**
 * Phase 60 (DISPATCH-02, D-02): 18 keyword patterns that signal multi-step
 * build intent on Discord. Verbatim from CONTEXT §D-02. Order is semantic —
 * not alphabetized — so grep-based debugging maps back to the CONTEXT list.
 *
 * All regexes use /i flag (case-insensitive) and \b word boundaries where
 * applicable. Intentionally conservative — false negatives preferred over
 * false positives (auto-dispatch is default-off; any production matching
 * is opt-in).
 */
export const KEYWORD_PATTERNS: KeywordPattern[] = [
  { id: 'build-a',               re: /\bbuild a\b/i },
  { id: 'set-up',                re: /\bset up\b/i },
  { id: 'create-a-new',          re: /\bcreate a new\b/i },
  { id: 'make-me-a',             re: /\bmake me a\b/i },
  { id: 'migrate-from',          re: /\bmigrate from\b/i },
  { id: 'refactor-into',         re: /\brefactor .+ into\b/i },
  { id: 'convert-to',            re: /\bconvert .+ to\b/i },
  { id: 'port-to',               re: /\bport .+ to\b/i },
  { id: 'scaffold',              re: /\bscaffold\b/i },
  { id: 'bootstrap',             re: /\bbootstrap\b/i },
  { id: 'initialize-a',          re: /\binitialize a\b/i },
  { id: 'spin-up-a',             re: /\bspin up a\b/i },
  { id: 'implement-a',           re: /\bimplement a\b/i },
  { id: 'write-me-a',            re: /\bwrite me a\b/i },
  { id: 'generate-a',            re: /\bgenerate a\b/i },
  { id: 'add-support-for',       re: /\badd support for\b/i },
  { id: 'integrate-with',        re: /\bintegrate .+ with\b/i },
  { id: 'implement-support-for', re: /\bimplement support for\b/i },
]

/**
 * Result of `maybeAutoDispatch` (lands in 60-03). Discriminated union on the
 * boolean `dispatch` field — TypeScript narrows each branch's payload.
 *
 * - `dispatch: true`  → caller routes the message to runOrchestrateDiscord.
 *                        `signalsMatched` is the list of keyword ids + complexity
 *                        signal ids that fired, for audit emission.
 * - `dispatch: false` → caller proceeds with normal chat handling.
 *                        `reason` explains why auto-dispatch did not fire
 *                        (for audit under 'auto_dispatch_refused' kind).
 */
export type DispatchResult =
  | { dispatch: true; signalsMatched: string[] }
  | {
      dispatch: false
      reason: 'disabled' | 'no_keyword' | 'complexity_gate' | 'cooldown' | 'budget_exceeded' | 'pending'
    }

// ============================================================================
// Phase 60-03 Task 1: pure helpers
// ============================================================================

/**
 * Iterate KEYWORD_PATTERNS sequentially and return the first match's id.
 * Returns null when no pattern matches. Per D-01: first-match-wins,
 * ordering-dependent (matches the CONTEXT §D-02 list order so grep debugging
 * is traceable).
 */
export function matchKeywordPattern(content: string): { id: string } | null {
  for (const pattern of KEYWORD_PATTERNS) {
    if (pattern.re.test(content)) return { id: pattern.id }
  }
  return null
}

/**
 * Compute the 4 independent complexity signals per D-03. Returns all 4 flags
 * so the caller can both (a) gate dispatch (≥2 true required) and (b) emit
 * the diagnostic signal list on auto_dispatch_refused for audit.
 *
 * Exact regex shapes are LOCKED per D-03 — changes here require a new phase.
 */
export function computeComplexitySignals(content: string): {
  taskBoundaries: boolean
  distinctFilenames: boolean
  dependencyLanguage: boolean
  wordCountOver200: boolean
} {
  // taskBoundaries: numbered list OR bullet list, ≥2 matches
  // (A single list with ≥2 items counts; either variant suffices.)
  const numberedMatches = (content.match(/^\s*\d+\./gm) ?? []).length
  const bulletMatches = (content.match(/^\s*[-*]\s/gm) ?? []).length
  const taskBoundaries = numberedMatches >= 2 || bulletMatches >= 2

  // distinctFilenames: ≥2 matches of file extension regex
  const filenameMatches = content.match(/\b[\w\-/]+\.(ts|tsx|js|jsx|py|md|json|yml|yaml|sh|rs|go)\b/g) ?? []
  const distinctFilenames = filenameMatches.length >= 2

  // dependencyLanguage: any match
  const dependencyLanguage = /\b(after .+, then|first .+ then|once .+ (is )?done|depends on|before .+, .+)\b/i.test(content)

  // wordCount > 200 (strict — 200 exact is NOT over)
  const wordCountOver200 = (content.match(/\S+/g) ?? []).length > 200

  return { taskBoundaries, distinctFilenames, dependencyLanguage, wordCountOver200 }
}

// ============================================================================
// Phase 60-03 Task 2: isAtBudgetThreshold (Q4 correction — uses getState)
// ============================================================================

/**
 * Local helper per 60-RESEARCH §Q4. We explicitly do NOT extend
 * DiscordTokenBudget's public API with a threshold check — instead we read
 * its `getState()` accessor (already part of the Phase 56 API) and compute
 * the threshold here. This avoids coupling budget internals to the
 * dispatch-intent module and keeps DiscordTokenBudget as a single-purpose
 * quota gate.
 *
 * Returns true when `usedToday / dailyTokens >= thresholdFraction`.
 * Used by `maybeAutoDispatch` with `thresholdFraction = 0.95` per DISPATCH-04
 * (refuse auto-dispatch when user is within 5% of daily quota — leaves
 * headroom for normal chat replies on the same day).
 */
export function isAtBudgetThreshold(
  budget: DiscordTokenBudget,
  userId: string,
  thresholdFraction: number,
): boolean {
  const { usedToday, dailyTokens } = budget.getState(userId)
  return usedToday >= dailyTokens * thresholdFraction
}

// ============================================================================
// Phase 60-03 Task 2: maybeAutoDispatch (single entry point for runner.ts)
// ============================================================================

/**
 * Map a complexity signal flag to its audit id. Stable keys flow into the
 * `signalsMatched` array on both auto_dispatched and auto_dispatch_refused
 * audit rows — post-hoc analytics query on these ids.
 */
const COMPLEXITY_SIGNAL_IDS = {
  taskBoundaries: 'task-boundaries',
  distinctFilenames: 'distinct-filenames',
  dependencyLanguage: 'dependency-language',
  wordCountOver200: 'word-count-over-200',
} as const

/**
 * Emit an audit row best-effort (fire-and-forget). appendAuditEntry already
 * swallows errors internally per src/security/audit.ts ("audit is
 * observability, not enforcement"), but we also wrap the call site in a
 * try/catch so a pathological rejection (e.g., spy in tests throwing
 * synchronously via the returned Promise) cannot surface in the dispatch
 * flow. Test 39 guards this path.
 */
async function emitAuditSafe(
  entry: Parameters<typeof appendAuditEntry>[0],
): Promise<void> {
  try {
    await appendAuditEntry(entry)
  } catch {
    // best-effort — never crash the dispatch flow on audit failure
  }
}

/**
 * Determine whether an incoming Discord message should be routed to
 * orchestration automatically. Check order is deliberately fast-path-first —
 * cheap gates short-circuit before expensive computation (per CONTEXT §code):
 *
 *   1. autoDispatch.enabled !== true   → 'disabled'        (NO audit)
 *   2. matchKeywordPattern = null       → 'no_keyword'      (NO audit — fast)
 *   3. checkCooldown(channelId)         → 'cooldown'        (audit: refused)
 *   4. hasPendingDispatch(channelId)    → 'pending'         (audit: refused)
 *   5. isAtBudgetThreshold(…, 0.95)     → 'budget_exceeded' (audit: refused)
 *   6. computeComplexitySignals < 2     → 'complexity_gate' (audit: refused)
 *   7. ELSE                              → dispatch:true    (audit: dispatched)
 *
 * Why this order:
 *   - Default-off check first: zero cost for users who haven't opted in.
 *   - no_keyword next: 99% of Discord messages will lack any keyword, so we
 *     avoid cooldown/budget lookups for the overwhelming majority of traffic.
 *   - cooldown/pending/budget are cheap O(1) Map/accessor reads before the
 *     more expensive regex-heavy complexity computation.
 *
 * Audit emission is best-effort; see emitAuditSafe above. Test 39 asserts
 * the dispatch flow survives a rejecting appendAuditEntry spy.
 */
export async function maybeAutoDispatch(args: {
  content: string
  channelId: string
  userId: string
  budget: DiscordTokenBudget
  config: DiscordConfig
  turnId?: string
  sessionId?: string
  platform?: string
  now?: () => number
}): Promise<DispatchResult> {
  const { content, channelId, userId, budget, config } = args
  const sessionId = args.sessionId ?? 'auto-dispatch'
  const platform = args.platform ?? process.platform

  // ── Step 1: default-off guard (DISPATCH-08) ────────────────────────────────
  if (config.autoDispatch?.enabled !== true) {
    return { dispatch: false, reason: 'disabled' }
  }

  // ── Step 2: keyword fast-path (DISPATCH-02) ────────────────────────────────
  const keyword = matchKeywordPattern(content)
  if (keyword === null) {
    return { dispatch: false, reason: 'no_keyword' }
  }

  const ts = new Date().toISOString()
  const contentSnippet = content.slice(0, 50)

  // ── Step 3: cooldown (DISPATCH-06) ─────────────────────────────────────────
  if (checkCooldown(channelId)) {
    void emitAuditSafe({
      kind: 'auto_dispatch_refused',
      ts,
      sessionId,
      platform,
      channelId,
      userId,
      dispatchReason: 'cooldown',
    })
    return { dispatch: false, reason: 'cooldown' }
  }

  // ── Step 4: pending (DISPATCH-05) ──────────────────────────────────────────
  if (hasPendingDispatch(channelId)) {
    void emitAuditSafe({
      kind: 'auto_dispatch_refused',
      ts,
      sessionId,
      platform,
      channelId,
      userId,
      dispatchReason: 'pending',
    })
    return { dispatch: false, reason: 'pending' }
  }

  // ── Step 5: budget threshold (DISPATCH-04) ─────────────────────────────────
  if (isAtBudgetThreshold(budget, userId, 0.95)) {
    void emitAuditSafe({
      kind: 'auto_dispatch_refused',
      ts,
      sessionId,
      platform,
      channelId,
      userId,
      dispatchReason: 'budget_exceeded',
    })
    return { dispatch: false, reason: 'budget_exceeded' }
  }

  // ── Step 6: complexity gate (DISPATCH-03, ≥2 signals) ──────────────────────
  const signals = computeComplexitySignals(content)
  const matchedSignalIds: string[] = []
  if (signals.taskBoundaries) matchedSignalIds.push(COMPLEXITY_SIGNAL_IDS.taskBoundaries)
  if (signals.distinctFilenames) matchedSignalIds.push(COMPLEXITY_SIGNAL_IDS.distinctFilenames)
  if (signals.dependencyLanguage) matchedSignalIds.push(COMPLEXITY_SIGNAL_IDS.dependencyLanguage)
  if (signals.wordCountOver200) matchedSignalIds.push(COMPLEXITY_SIGNAL_IDS.wordCountOver200)

  if (matchedSignalIds.length < 2) {
    void emitAuditSafe({
      kind: 'auto_dispatch_refused',
      ts,
      sessionId,
      platform,
      channelId,
      userId,
      dispatchReason: 'complexity_gate',
      // Include which signals DID fire so diagnostic queries can surface
      // near-miss patterns ("keyword + 1 signal — should we loosen the gate?").
      signalsMatched: matchedSignalIds,
    })
    return { dispatch: false, reason: 'complexity_gate' }
  }

  // ── Step 7: DISPATCH (DISPATCH-09) ─────────────────────────────────────────
  const signalsMatched = [keyword.id, ...matchedSignalIds]
  void emitAuditSafe({
    kind: 'auto_dispatched',
    ts,
    sessionId,
    platform,
    turnId: args.turnId,
    channelId,
    userId,
    contentSnippet,
    signalsMatched,
  })
  return { dispatch: true, signalsMatched }
}
