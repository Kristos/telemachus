/**
 * RouterProvider — Phase 59 (ROUTE-01..05)
 *
 * Implements the Provider interface for Discord-only per-turn model routing.
 * On each Discord turn it:
 *   1. Runs a heuristic fast-path for trivial messages (ROUTE-02)
 *   2. Calls a classifier with capped input (ROUTE-03)
 *   3. Fails open to 'complex' on any error/timeout/malformed output (ROUTE-04)
 *   4. Emits router_decision (once per turnId) + router_escalation on errors (ROUTE-05)
 *
 * Assembly happens ONLY in src/discord/index.ts (ROUTE-06).
 * Semaphore wraps OUTSIDE the Router (ROUTE-07).
 */

import { encode } from 'gpt-tokenizer'
import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse } from './types.js'
import type { RouterConfig, IntentClass } from '../config/types.js'
import { appendAuditEntry, type AuditEntry } from '../security/audit.js'
import { log } from '../log/logger.js'
import { RouterClassifierBreaker } from './router-classifier-breaker.js'
import type { BiasCache } from '../shared/trajectory.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entries in the decision cache (D-02: FIFO insertion-order). */
const CACHE_MAX = 128

/** Keywords that reject the fast-path heuristic (ROUTE-02). */
const KEYWORD_REGEX = /\b(implement|debug|refactor|fix|write|build)\b/i

/** Code fence marker that rejects the fast-path heuristic (ROUTE-02). */
const CODE_FENCE = '```'

/**
 * Zero-shot classifier prompt (D-14). Instructs the LLM to respond ONLY with
 * a JSON object. Wording is locked per CONTEXT.md D-14.
 * Phase 74 (ROUTE-01): updated to 4-class classification.
 */
const CLASSIFIER_PROMPT = [
  'Classify this user message. Respond ONLY with JSON {"decision":"code"|"research"|"orchestration"|"casual"}.',
  '`casual` = greeting, short question, chitchat, single factual lookup, clarification.',
  '`code` = write code, debug, refactor, implement, review code, fix a bug.',
  '`research` = explain concept, compare options, analyze, summarize, answer with depth.',
  '`orchestration` = multi-step task, requires multiple tools, plan + execute, coordinate actions.',
].join(' ')

const VALID_INTENTS: ReadonlySet<IntentClass> = new Set(['code', 'research', 'orchestration', 'casual'])

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RouterProviderOptions {
  classifier: Provider
  simple: Provider
  complex: Provider
  /**
   * Phase 74 (ROUTE-02): optional per-intent provider slots.
   * When absent, routes to the existing simple/complex slots.
   * Note: no orchestration slot — orchestration ALWAYS uses complex (ROUTE-03).
   */
  code?: Provider
  research?: Provider
  casual?: Provider
  config: RouterConfig
  /**
   * Discord channel ID for audit attribution (D-04).
   * Plan 59-04 sets this at assembly time via the Discord enqueue closure.
   */
  channelId?: string
  /** TRAJ-04: bias cache loaded at startup; nudges casual intent to complex. */
  biasCache?: BiasCache
  /** TRAJ-04: transport identity for bias lookup ('discord' | 'telegram'). */
  transport?: 'discord' | 'telegram'
}

// ---------------------------------------------------------------------------
// RouterProvider class
// ---------------------------------------------------------------------------

export class RouterProvider implements Provider {
  readonly name = 'router'
  private readonly classifier: Provider
  private readonly simple: Provider
  private readonly complex: Provider
  /** Phase 74 (ROUTE-02): optional per-intent provider slots. */
  private readonly code: Provider | undefined
  private readonly research: Provider | undefined
  private readonly casual: Provider | undefined
  private readonly config: RouterConfig
  private readonly channelId: string | undefined
  /** TRAJ-04: bias cache for casual→complex upgrades. */
  private readonly biasCache: BiasCache | undefined
  /** TRAJ-04: transport identity for bias lookup. */
  private readonly transport: 'discord' | 'telegram' | undefined
  /** Decision cache — bounded FIFO Map (D-01, D-02). Phase 74: value type widened to IntentClass. */
  private decisionCache = new Map<string, IntentClass>()
  /**
   * COST-05 (Phase 61): per-instance breaker. Pauses classifier calls after
   * sustained escalations so we stop wasting the 2s timeout wait + fail-open
   * to complex on every turn during a prolonged Z.ai rate-limit window.
   */
  private readonly breaker: RouterClassifierBreaker

  constructor(opts: RouterProviderOptions) {
    this.classifier = opts.classifier
    this.simple = opts.simple
    this.complex = opts.complex
    this.code = opts.code
    this.research = opts.research
    this.casual = opts.casual
    this.config = opts.config
    this.channelId = opts.channelId
    this.biasCache = opts.biasCache
    this.transport = opts.transport
    this.breaker = new RouterClassifierBreaker(opts.config.classifierBreaker ?? {})
  }

  /**
   * Route a Discord turn to simple or complex sub-provider.
   *
   * Throws if opts.turnId is missing (Discord-only invariant — D-03).
   * Caches the decision per turnId (D-01, D-02).
   */
  async stream(
    messages: Message[],
    tools: APIToolSchema[],
    opts: StreamOptions,
  ): Promise<StreamResponse> {
    if (!opts.turnId) {
      throw new Error(
        'RouterProvider requires opts.turnId (Discord-only invariant; see ROUTE-06). ' +
          'If you see this in CLI or agent-runner, RouterProvider is incorrectly wired.',
      )
    }

    // Cache lookup (D-01)
    let decision = this.decisionCache.get(opts.turnId)
    if (!decision) {
      decision = await this.decide(messages, opts)
      this.cacheDecision(opts.turnId, decision)
    }

    // Write routerSession.routedTo (D-12) + routedModel (Phase 59.1 D-04, D-05, D-06)
    if (opts.routerSession) {
      opts.routerSession.routedTo = decision
      opts.routerSession.routedModel = this.resolveRoutedModel(decision)
    }

    const target = this.selectProvider(decision)
    return target.stream(messages, tools, opts)
  }

  /**
   * Phase 59.1 (D-04, D-06): Resolve the plain model ID for the routed decision.
   * Prefers RouterConfig per-intent model overrides when set (explicit override),
   * otherwise falls back to complexModel/simpleModel, then to the sub-provider's `.name`.
   *
   * Phase 74 (ROUTE-02): per-intent model resolution:
   *   - casual → casualModel → simpleModel → simple.name
   *   - code   → codeModel   → complexModel → complex.name
   *   - research → researchModel → complexModel → complex.name
   *   - orchestration → complexModel → complex.name (ROUTE-03: never uses casualModel etc)
   *
   * FallbackProvider edge case (D-05): Always reports the primary sub-provider's
   * configured model. If the inner FallbackProvider fires over to a backup
   * during the stream, that's captured separately by the provider_switch audit
   * event; routedModel remains the primary. Rare-case cost-attribution
   * inaccuracy is acceptable.
   */
  private resolveRoutedModel(decision: IntentClass): string {
    if (decision === 'casual') {
      const model = this.config.casualModel ?? this.config.simpleModel
      if (model) return model
      return this.extractProviderModel(this.casual ?? this.simple)
    }
    if (decision === 'code') {
      const model = this.config.codeModel ?? this.config.complexModel
      if (model) return model
      return this.extractProviderModel(this.code ?? this.complex)
    }
    if (decision === 'research') {
      const model = this.config.researchModel ?? this.config.complexModel
      if (model) return model
      return this.extractProviderModel(this.research ?? this.complex)
    }
    // orchestration — always complex (ROUTE-03)
    if (this.config.complexModel) return this.config.complexModel
    return this.extractProviderModel(this.complex)
  }

  /**
   * Extract the plain model ID from a provider.name, stripping any provider-type
   * prefix (e.g. 'openai-compat:glm-4.7-flash' → 'glm-4.7-flash').
   */
  private extractProviderModel(provider: Provider): string {
    const name = provider.name
    return name.includes(':') ? name.split(':').slice(-1)[0] : name
  }

  /**
   * Phase 74 (ROUTE-02): Select the target provider for an intent decision.
   * Routing rules:
   *   - casual → this.casual if set, else this.simple
   *   - code → this.code if set, else this.complex
   *   - research → this.research if set, else this.complex
   *   - orchestration → ALWAYS this.complex (ROUTE-03)
   */
  private selectProvider(intent: IntentClass): Provider {
    // TRAJ-04/05: check bias — if override rate is high enough, upgrade
    // 'casual' to complex. Other intents already route to complex.
    if (intent === 'casual' && this.biasCache && this.transport) {
      if (this.biasCache.shouldUpgrade(this.transport, intent)) {
        return this.complex
      }
    }
    switch (intent) {
      case 'casual':
        return this.casual ?? this.simple
      case 'code':
        return this.code ?? this.complex
      case 'research':
        return this.research ?? this.complex
      case 'orchestration':
        return this.complex
    }
  }

  // ---------------------------------------------------------------------------
  // Private: decision lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Store a decision in the bounded FIFO cache.
   * Evicts the oldest entry when the cache is full (D-02).
   */
  private cacheDecision(turnId: string, decision: IntentClass): void {
    if (this.decisionCache.size >= CACHE_MAX) {
      const oldest = this.decisionCache.keys().next().value
      if (oldest !== undefined) this.decisionCache.delete(oldest)
    }
    this.decisionCache.set(turnId, decision)
  }

  /**
   * Decide which intent class to route to for a new turnId.
   *
   * Tries heuristic fast-path first (ROUTE-02), then classifier (ROUTE-03),
   * failing open to 'orchestration' on any error (ROUTE-04).
   * Phase 74: returns IntentClass instead of 'simple'|'complex'.
   */
  private async decide(messages: Message[], opts: StreamOptions): Promise<IntentClass> {
    const start = Date.now()
    const userMsg = extractLatestUserText(messages)
    const wasCompressed = isLatestUserCompressed(messages)

    // ROUTE-02: fast-path heuristic — short casual messages bypass classifier
    if (this.config.heuristicEnabled !== false && isFastPath(userMsg)) {
      void this.emitDecision(opts, 'casual', true, 0, Date.now() - start, wasCompressed)
      return 'casual'
    }

    // ROUTE-03 + ROUTE-04: classifier with fail-open
    return this.classify(messages, opts, wasCompressed, start)
  }

  /**
   * Call the classifier with a 600-token-capped input.
   * Fails open to 'orchestration' on error, timeout, or malformed output (ROUTE-04).
   * Phase 74: returns IntentClass instead of 'simple'|'complex'.
   */
  private async classify(
    messages: Message[],
    opts: StreamOptions,
    wasCompressed: boolean,
    start: number,
  ): Promise<IntentClass> {
    // COST-05 (Phase 61): consult the per-instance breaker before invoking
    // the classifier. When open, skip the classifier entirely and fail-open to
    // orchestration — saves the 2s timeout wait and the classifier network call.
    // emitDecision still fires with fastPath=false + classifierTokens=0 so
    // turn_summary.layerBreakdown.routedTo stays accurate for audit.
    if (this.breaker.tryAcquire() === 'skip') {
      const latencyMs = Date.now() - start
      void this.emitDecision(opts, 'orchestration', false, 0, latencyMs, wasCompressed)
      return 'orchestration'
    }

    const cap = this.config.classifierTokenCap ?? 600
    // Phase 59.1-02 (999.11 path 1): default lowered 5000→2000 after production
    // observation (2026-04-18) that Z.ai tarpits rate-limited requests past the
    // original 5s budget. Classifier happy-path latency is ~400ms direct-API
    // (verified post-thinking:disabled); 2s gives 5× headroom while capping
    // user-visible wait on rate-limit events. Config override remains available
    // via RouterConfig.classifierTimeoutMs for users wanting longer budgets.
    const timeoutMs = this.config.classifierTimeoutMs ?? 2000

    const currentUserMsg = extractLatestUserText(messages)
    const currentMsgTokens = encode(currentUserMsg).length
    const tail = messages.slice(-6, -1) // last 5 messages before the current
    const tailProse = buildTailProse(tail, currentMsgTokens, cap)
    const classifierMessages = buildClassifierMessages(currentUserMsg, tailProse)

    let classifierTokens = 0
    let decision: IntentClass = 'orchestration'
    let reason: 'classifier_error' | 'classifier_timeout' | 'invalid_output' | null = null
    // Phase 59.1 (FIX-ROUTER-01, D-03): capture raw classifier text so the
    // router_escalation audit entry can surface it when reason === 'invalid_output'.
    let classifierRawText = ''

    try {
      const classifierPromise = this.classifier.stream(classifierMessages, [], {
        onTextChunk: () => {},
        // Phase 59.1 (FIX-ROUTER-02, D-02): bumped 10 → 50 because
        // `{"decision":"simple"}` is ~11-13 tokens in cl100k and was being
        // truncated, producing invalid_output on every classifier call.
        maxTokens: 50,
        responseFormat: { type: 'json_object' },
        // Phase 59.1-02 (FIX-ROUTER-02): GLM-4.7-Flash is a reasoning model.
        // With thinking enabled it routes content through delta.reasoning_content
        // and consumes the entire max_tokens budget on internal thinking BEFORE
        // emitting any delta.content. Disabling the reasoning phase is the only
        // way to get a direct JSON response within a 50-token budget.
        // Reference: https://docs.z.ai/api-reference/llm/chat-completion
        thinking: { type: 'disabled' },
        turnId: opts.turnId,
      })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('classifier_timeout')), timeoutMs),
      )
      const result = await Promise.race([classifierPromise, timeoutPromise])
      classifierTokens = result.usage.outputTokens
      classifierRawText = result.text

      try {
        const parsed = JSON.parse(result.text) as { decision?: unknown }
        if (typeof parsed.decision === 'string' && VALID_INTENTS.has(parsed.decision as IntentClass)) {
          decision = parsed.decision as IntentClass
        } else {
          reason = 'invalid_output'
        }
      } catch {
        reason = 'invalid_output'
      }
    } catch (err) {
      reason =
        err instanceof Error && err.message === 'classifier_timeout'
          ? 'classifier_timeout'
          : 'classifier_error'
      log(
        'warn',
        {
          module: 'router',
          turnId: opts.turnId,
          reason,
          err: err instanceof Error ? err.message : String(err),
        },
        'classifier fail-open',
      )
    }

    const latencyMs = Date.now() - start

    // Emit router_escalation on failure (D-04, ROUTE-04)
    if (reason) {
      const baseEscalation: AuditEntry = {
        ts: new Date().toISOString(),
        kind: 'router_escalation',
        sessionId: 'router',
        platform: process.platform,
        turnId: opts.turnId,
        discordChannelId: this.channelId,
        reason,
      }
      // Phase 59.1 (FIX-ROUTER-01, D-03): attach raw classifier response on
      // invalid_output so operators can diagnose parse failures (e.g. markdown
      // fence wrapping) without re-running the turn. Truncate to 500 chars
      // with ellipsis suffix to bound audit log size on pathological outputs.
      const escalation: AuditEntry =
        reason === 'invalid_output'
          ? { ...baseEscalation, classifierRawResponse: truncateForAudit(classifierRawText, 500) }
          : baseEscalation
      void appendAuditEntry(escalation)

      // COST-05 (Phase 61): record escalation on the breaker. When the
      // transition opens or re-opens the circuit, emit a
      // router_classifier_paused audit entry so operators can grep for
      // sustained rate-limit windows.
      const transition = this.breaker.recordEscalation()
      if (transition.transition === 'opened' || transition.transition === 'stay_open') {
        const snap = this.breaker.snapshot()
        void appendAuditEntry({
          ts: new Date().toISOString(),
          kind: 'router_classifier_paused',
          sessionId: 'router',
          platform: process.platform,
          turnId: opts.turnId,
          discordChannelId: this.channelId,
          classifierPauseReason:
            transition.transition === 'opened' ? 'escalation_threshold' : 'probe_failed',
          consecutiveEscalations: snap.consecutive,
          cooldownMs: snap.cooldownMs,
          classifierName: this.classifier.name,
        })
      }
    } else {
      // COST-05: classifier returned a valid decision — close the breaker
      // (self-heal) so a temporary window of failures doesn't permanently
      // pause the classifier after recovery.
      this.breaker.recordSuccess()
    }

    // Emit router_decision (exactly once per turnId — D-05, ROUTE-05)
    void this.emitDecision(opts, decision, false, classifierTokens, latencyMs, wasCompressed)
    return decision
  }

  /**
   * Emit a router_decision audit entry and accumulate classifierTokens into routerSession.
   * Fire-and-forget (void) — never awaited per audit best-effort pattern.
   */
  private emitDecision(
    opts: StreamOptions,
    decision: IntentClass,
    fastPath: boolean,
    classifierTokens: number,
    latencyMs: number,
    wasCompressed: boolean,
  ): void {
    // Accumulate classifier tokens into routerSession for runner.ts aggregator (D-12)
    if (opts.routerSession) {
      opts.routerSession.classifierTokens =
        (opts.routerSession.classifierTokens ?? 0) + classifierTokens
    }

    void appendAuditEntry({
      ts: new Date().toISOString(),
      kind: 'router_decision',
      sessionId: 'router',
      platform: process.platform,
      turnId: opts.turnId,
      discordChannelId: this.channelId,
      decision,
      fastPath,
      classifierTokens,
      latencyMs,
      wasCompressed,
    })
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (unit-testable via export)
// ---------------------------------------------------------------------------

/**
 * Extract the text of the most-recent user message from the messages array.
 * Returns empty string if no user message is found.
 */
export function extractLatestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b: { type?: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join(' ')
    }
  }
  return ''
}

/**
 * Returns true if the most-recent user message has the `compressed` flag set.
 * Used to populate the wasCompressed field on router_decision (Phase 57 D-18).
 */
function isLatestUserCompressed(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].compressed === true
  }
  return false
}

/**
 * Fast-path heuristic (ROUTE-02):
 * A message qualifies if it has <10 words, no code keywords, and no code fences.
 */
export function isFastPath(text: string): boolean {
  if (text.includes(CODE_FENCE)) return false
  if (KEYWORD_REGEX.test(text)) return false
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0)
  return words.length < 10
}

/**
 * Build the tail prose string from the last N messages (before the current one).
 * Truncates from OLDEST first until total token count is within the cap (D-08).
 * If the current message alone exceeds the cap, returns '' (Pitfall 6 — accepted).
 */
function buildTailProse(tailMessages: Message[], currentMsgTokens: number, cap: number): string {
  const pieces: string[] = []
  for (const m of tailMessages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b: { type?: string }) => b.type === 'text')
              .map((b: { text?: string }) => b.text ?? '')
              .join(' ')
          : ''
    if (!text) continue
    pieces.push(`${m.role}: ${text}`)
  }

  // Shrink from OLDEST first (pieces[0]) until total ≤ cap
  while (pieces.length > 0) {
    const joined = pieces.join('\n')
    const totalTokens = encode(joined).length + currentMsgTokens
    if (totalTokens <= cap) return joined
    pieces.shift()
  }
  // Tail fully dropped; current message may still exceed cap (Pitfall 6 — documented)
  return ''
}

/**
 * Phase 59.1 (FIX-ROUTER-01, D-03): Truncate a string to `max` characters,
 * appending an ellipsis when the original exceeded the limit. Short strings
 * pass through unchanged. Used to bound classifierRawResponse audit fields.
 */
export function truncateForAudit(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/**
 * Build the two-message array for the classifier (D-15).
 * Single system message + single user message with tail condensed into prose.
 */
function buildClassifierMessages(currentUserMsg: string, tailProse: string): Message[] {
  const userContent = tailProse
    ? `Recent context:\n${tailProse}\n\nCurrent message: ${currentUserMsg}`
    : `Current message: ${currentUserMsg}`
  return [
    { role: 'system', content: CLASSIFIER_PROMPT },
    { role: 'user', content: userContent },
  ]
}
