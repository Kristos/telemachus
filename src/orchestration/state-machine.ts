/**
 * Phase 38: Task state machine for the orchestration engine.
 *
 * Implements a lookup-table–based state machine (D-01) over the 9
 * OrchestrationState values. `transition()` is a pure function — it returns
 * a new TaskTransitionEvent object and never mutates any external state.
 *
 * Usage:
 *   const event = transition('queued', 'worker_running', 'task-abc')
 *   // => { taskId: 'task-abc', fromState: 'queued', toState: 'worker_running', timestamp: '...' }
 */

import type { OrchestrationState, TaskTransitionEvent } from './types.js'

/**
 * Complete map of allowed outbound transitions for every orchestration state.
 * Terminal states map to empty arrays — they have no outbound edges.
 */
export const TRANSITION_MAP: Record<OrchestrationState, readonly OrchestrationState[]> = {
  queued: ['worker_running', 'failed'],
  worker_running: ['review_pending', 'failed'],
  review_pending: ['reviewing', 'failed'],
  reviewing: ['approved', 'rejected', 'redirected', 'escalated', 'failed'],
  approved: [],
  rejected: [],
  redirected: [],
  escalated: [],
  failed: [],
}

/**
 * Attempt a state transition for a task.
 *
 * @param current - The task's current state.
 * @param next    - The desired next state.
 * @param taskId  - The task identifier (for error messages and the event record).
 * @param data    - Optional structured context to attach to the event.
 * @returns A new TaskTransitionEvent with an ISO 8601 timestamp.
 * @throws Error if the transition is not allowed by TRANSITION_MAP.
 */
export function transition(
  current: OrchestrationState,
  next: OrchestrationState,
  taskId: string,
  data?: Record<string, unknown>,
): TaskTransitionEvent {
  const allowed = TRANSITION_MAP[current]
  if (!allowed.includes(next)) {
    throw new Error(`Invalid transition: ${current} -> ${next} for task ${taskId}`)
  }

  const event: TaskTransitionEvent = {
    taskId,
    fromState: current,
    toState: next,
    timestamp: new Date().toISOString(),
  }

  if (data !== undefined) {
    return { ...event, data }
  }

  return event
}
