import { describe, test, expect } from 'bun:test'
import { transition, TRANSITION_MAP } from './state-machine.js'
import { TERMINAL_STATES } from './types.js'
import type { OrchestrationState } from './types.js'

describe('TERMINAL_STATES', () => {
  test('contains exactly the five terminal states', () => {
    const expected: OrchestrationState[] = ['approved', 'rejected', 'redirected', 'escalated', 'failed']
    expect(TERMINAL_STATES.size).toBe(5)
    for (const state of expected) {
      expect(TERMINAL_STATES.has(state)).toBe(true)
    }
  })
})

describe('TRANSITION_MAP', () => {
  test('snapshot of all allowed transitions', () => {
    expect(TRANSITION_MAP['queued']).toEqual(['worker_running', 'failed'])
    expect(TRANSITION_MAP['worker_running']).toEqual(['review_pending', 'failed'])
    expect(TRANSITION_MAP['review_pending']).toEqual(['reviewing', 'failed'])
    expect(TRANSITION_MAP['reviewing']).toEqual(['approved', 'rejected', 'redirected', 'escalated', 'failed'])
    expect(TRANSITION_MAP['approved']).toEqual([])
    expect(TRANSITION_MAP['rejected']).toEqual([])
    expect(TRANSITION_MAP['redirected']).toEqual([])
    expect(TRANSITION_MAP['escalated']).toEqual([])
    expect(TRANSITION_MAP['failed']).toEqual([])
  })

  test('all 9 states are present in TRANSITION_MAP', () => {
    const allStates: OrchestrationState[] = [
      'queued', 'worker_running', 'review_pending', 'reviewing',
      'approved', 'rejected', 'redirected', 'escalated', 'failed',
    ]
    for (const state of allStates) {
      expect(state in TRANSITION_MAP).toBe(true)
    }
  })

  test('terminal states have empty allowed-transitions arrays', () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITION_MAP[state]).toEqual([])
    }
  })
})

describe('transition()', () => {
  test('valid: queued -> worker_running returns typed event', () => {
    const event = transition('queued', 'worker_running', 'task-1')
    expect(event.fromState).toBe('queued')
    expect(event.toState).toBe('worker_running')
    expect(event.taskId).toBe('task-1')
  })

  test('valid: reviewing -> approved returns typed event', () => {
    const event = transition('reviewing', 'approved', 'task-2')
    expect(event.fromState).toBe('reviewing')
    expect(event.toState).toBe('approved')
    expect(event.taskId).toBe('task-2')
  })

  test('returns ISO 8601 timestamp string', () => {
    const event = transition('queued', 'worker_running', 'task-ts')
    expect(typeof event.timestamp).toBe('string')
    // ISO 8601 format
    expect(() => new Date(event.timestamp)).not.toThrow()
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp)
  })

  test('includes data field when provided', () => {
    const data = { reason: 'test', count: 42 }
    const event = transition('queued', 'worker_running', 'task-data', data)
    expect(event.data).toEqual(data)
  })

  test('omits data field when not provided', () => {
    const event = transition('queued', 'worker_running', 'task-nodata')
    expect(event.data).toBeUndefined()
  })

  test('invalid: queued -> approved throws "Invalid transition"', () => {
    expect(() => transition('queued', 'approved', 'task-1')).toThrow('Invalid transition')
  })

  test('invalid transition error message includes states and taskId', () => {
    expect(() => transition('queued', 'approved', 'task-1')).toThrow(
      'Invalid transition: queued -> approved for task task-1'
    )
  })

  test('invalid: worker_running -> reviewing throws', () => {
    expect(() => transition('worker_running', 'reviewing', 'task-x')).toThrow('Invalid transition')
  })

  test('invalid: approved -> failed throws (terminal state)', () => {
    expect(() => transition('approved', 'failed', 'task-t')).toThrow('Invalid transition')
  })

  test('all 9 valid transitions succeed and return typed events', () => {
    const validTransitions: [OrchestrationState, OrchestrationState][] = [
      ['queued', 'worker_running'],
      ['queued', 'failed'],
      ['worker_running', 'review_pending'],
      ['worker_running', 'failed'],
      ['review_pending', 'reviewing'],
      ['review_pending', 'failed'],
      ['reviewing', 'approved'],
      ['reviewing', 'rejected'],
      ['reviewing', 'redirected'],
      // reviewing -> escalated and reviewing -> failed complete the 9
    ]
    // count: queued(2) + worker_running(2) + review_pending(2) + reviewing(5) = 11 edges total
    // The plan says "All 9 valid state transitions" likely meaning 9 states, each having outbound edges
    // Let's test all outbound edges
    const allEdges: [OrchestrationState, OrchestrationState][] = [
      ['queued', 'worker_running'],
      ['queued', 'failed'],
      ['worker_running', 'review_pending'],
      ['worker_running', 'failed'],
      ['review_pending', 'reviewing'],
      ['review_pending', 'failed'],
      ['reviewing', 'approved'],
      ['reviewing', 'rejected'],
      ['reviewing', 'redirected'],
      ['reviewing', 'escalated'],
      ['reviewing', 'failed'],
    ]
    for (const [from, to] of allEdges) {
      const event = transition(from, to, `task-${from}-${to}`)
      expect(event.fromState).toBe(from)
      expect(event.toState).toBe(to)
    }
  })

  test('returns a new object (immutable — does not mutate state)', () => {
    const event1 = transition('queued', 'worker_running', 'task-1')
    const event2 = transition('queued', 'worker_running', 'task-1')
    expect(event1).not.toBe(event2)
  })
})
