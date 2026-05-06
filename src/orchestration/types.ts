/**
 * Phase 38: Core orchestration types.
 *
 * Defines the 9 orchestration states, terminal state set, and the event
 * record produced by each state transition. These are the contracts that all
 * downstream orchestration modules (state machine, event log, queue, budget)
 * depend on.
 *
 * Domain-specific, not generic — typed directly to the 9 orchestration
 * states per D-02. No premature abstraction.
 */

export type OrchestrationState =
  | 'queued'
  | 'worker_running'
  | 'review_pending'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'redirected'
  | 'escalated'
  | 'failed'

/**
 * States that have no outbound transitions. Once a task enters one of these
 * states, no further transitions are possible.
 */
export const TERMINAL_STATES: ReadonlySet<OrchestrationState> = new Set<OrchestrationState>([
  'approved',
  'rejected',
  'redirected',
  'escalated',
  'failed',
])

/**
 * The immutable event record produced by each state transition.
 * One JSONL line per transition in the orchestration event log (D-04).
 */
export interface TaskTransitionEvent {
  taskId: string
  fromState: OrchestrationState
  toState: OrchestrationState
  /** ISO 8601 timestamp at the moment of transition. */
  timestamp: string
  /** Optional structured context for the transition (e.g. error message, reviewer decision). */
  data?: Record<string, unknown>
}

/** Structured handoff produced by the worker agent after completing a task. */
export interface WorkerHandoff {
  taskId: string
  runId: string
  attemptNumber: number
  branchName: string
  worktreePath: string
  gitDiff: string
  summary: string
  decisions: string[]
  constraints_encountered: string[]
}

/** A single retry history entry injected into the worker's system prompt on redirect. */
export interface RetryHistoryEntry {
  attemptNumber: number
  gitDiff: string
  summary: string
  reviewerFeedback: string
}
