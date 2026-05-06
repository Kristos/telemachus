/**
 * Phase 40-03 (ENTRY-03): Discord DM escalation handler.
 *
 * Provides `createEscalationHandler` — a factory that creates a closure-scoped
 * escalation handler for a single Discord owner. Each call produces a fresh,
 * isolated handler suitable for one orchestration run.
 *
 * Usage:
 *   const escalation = createEscalationHandler(sendDm, ownerId)
 *   // Wire into engine hooks:
 *   hooks.onEscalated = escalation.onEscalated
 *   // In DM routing (before agent loop):
 *   if (escalation.hasPending()) escalation.receiveDmReply(content)
 */

import { log } from '../log/logger.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EscalationHandler {
  /**
   * Called by the orchestration engine when a task reaches 'escalated' state
   * with a require_human escalation policy.
   *
   * Sends a DM to the owner and returns a Promise that resolves when:
   * - Owner replies 'approve' / 'yes' → 'approve'
   * - Owner replies 'reject' / 'no' → 'reject'
   * - Timeout fires without reply → 'reject'
   */
  onEscalated: (
    taskId: string,
    diff: string,
    reviewerFeedback: string,
    timeoutMs: number,
  ) => Promise<'approve' | 'reject'>

  /**
   * Called by the DM reply router when a DM arrives during an active escalation.
   *
   * Returns true if the message was consumed (approve/reject recognized);
   * false if no pending escalation or unrecognized reply.
   *
   * When false AND hasPending() is true, the caller should send a hint DM.
   */
  receiveDmReply: (content: string) => boolean

  /**
   * Returns true when an escalation is waiting for a human reply.
   * Use to intercept DMs before the agent loop sees them.
   */
  hasPending: () => boolean
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Maximum diff length in the DM (chars). Larger diffs get truncated. */
const MAX_DIFF_CHARS = 1000

/** Maximum reviewer feedback length in the DM (chars). */
const MAX_FEEDBACK_CHARS = 500

/** Hard cap on escalation timeout (4 hours). Safety valve against infinite waits. */
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000 // 4 hours

// ---------------------------------------------------------------------------
// DM formatting
// ---------------------------------------------------------------------------

/**
 * Format the escalation DM text.
 * Total budget ~1900 chars (100 chars margin under Discord's 2000-char limit).
 */
function formatEscalationDm(
  taskId: string,
  diff: string,
  reviewerFeedback: string,
  timeoutMs: number,
): string {
  // Truncate reviewer feedback
  const feedback =
    reviewerFeedback.length > MAX_FEEDBACK_CHARS
      ? reviewerFeedback.slice(0, MAX_FEEDBACK_CHARS) + '...'
      : reviewerFeedback

  // Truncate diff
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)'
      : diff

  // Format timeout as minutes for display
  const timeoutMinutes = Math.round(timeoutMs / 60_000)
  const timeoutDisplay = timeoutMinutes > 0 ? `${timeoutMinutes}min` : `${Math.round(timeoutMs / 1000)}s`

  const lines = [
    `**Orchestration escalation: task \`${taskId}\`**`,
    `Reviewer: ${feedback}`,
    '```diff',
    truncatedDiff,
    '```',
    `Reply \`approve\` or \`reject\` within ${timeoutDisplay}. No reply = auto-reject.`,
  ]

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new escalation handler bound to a specific Discord owner.
 *
 * State is closure-scoped — each call produces an independent handler.
 * This ensures test isolation and prevents cross-run state bleed.
 *
 * @param sendDm  - Function to send a DM to a Discord user
 * @param ownerId - Discord user ID of the bot owner who receives escalations
 */
export function createEscalationHandler(
  sendDm: (userId: string, text: string) => Promise<void>,
  ownerId: string,
): EscalationHandler {
  // Closure-scoped pending resolver — null when no escalation is active
  let pending: ((decision: 'approve' | 'reject') => void) | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  const onEscalated = (
    taskId: string,
    diff: string,
    reviewerFeedback: string,
    timeoutMs: number,
  ): Promise<'approve' | 'reject'> => {
    // Clamp timeout to safety cap
    const effectiveTimeout = Math.min(timeoutMs, MAX_TIMEOUT_MS)

    // Format the DM text
    const dmText = formatEscalationDm(taskId, diff, reviewerFeedback, effectiveTimeout)

    // Set up the pending Promise BEFORE awaiting sendDm, so receiveDmReply
    // works as soon as onEscalated is called (not after the async sendDm resolves).
    return new Promise<'approve' | 'reject'>((resolve) => {
      pending = resolve

      // Set timeout — fires if no reply arrives
      pendingTimer = setTimeout(() => {
        if (pending !== null) {
          pending = null
          pendingTimer = null
          resolve('reject')
        }
      }, effectiveTimeout)

      // Send DM fire-and-forget after setting up the pending state.
      // Errors are swallowed — a DM failure should not crash the engine.
      void sendDm(ownerId, dmText).catch((err: unknown) => {
        log('error', { module: 'orchestration-escalation', userId: ownerId, taskId, error: err instanceof Error ? err.message : String(err) }, 'failed to send escalation DM')
      })
    })
  }

  const receiveDmReply = (content: string): boolean => {
    if (pending === null) return false

    const normalized = content.toLowerCase().trim()

    let decision: 'approve' | 'reject' | null = null
    if (normalized === 'approve' || normalized === 'yes') {
      decision = 'approve'
    } else if (normalized === 'reject' || normalized === 'no') {
      decision = 'reject'
    }

    if (decision === null) return false

    // Clear timeout and resolve
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    const resolver = pending
    pending = null
    resolver(decision)
    return true
  }

  const hasPending = (): boolean => pending !== null

  return { onEscalated, receiveDmReply, hasPending }
}
