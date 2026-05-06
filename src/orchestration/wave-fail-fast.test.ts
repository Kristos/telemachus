import { describe, it, expect } from 'bun:test'
import type { OrchestrationState } from './types.js'
import type { TaskResult } from './engine.js'
import type { FailedTaskInfo } from './wave-fail-fast.js'
import {
  computeFailureRate,
  shouldGate,
  formatErrorExcerpt,
  buildWaveSnapshot,
} from './wave-fail-fast.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkResult = (id: string, finalState: OrchestrationState, error?: string): TaskResult => ({
  taskId: id,
  finalState,
  attempts: 1,
  error,
})

// ---------------------------------------------------------------------------
// computeFailureRate
// ---------------------------------------------------------------------------

describe('computeFailureRate', () => {
  it('returns 0 when total === 0 (no division by zero / NaN)', () => {
    expect(computeFailureRate(0, 0)).toBe(0)
  })

  it('returns 0 when failed === 0', () => {
    expect(computeFailureRate(0, 5)).toBe(0)
  })

  it('returns 0.4 for 2/5', () => {
    expect(computeFailureRate(2, 5)).toBe(0.4)
  })

  it('returns 1.0 for 5/5', () => {
    expect(computeFailureRate(5, 5)).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// shouldGate
// ---------------------------------------------------------------------------

describe('shouldGate', () => {
  it('returns false when rate is below threshold', () => {
    expect(shouldGate(0, 0.5)).toBe(false)
  })

  it('returns true when rate equals threshold (>= comparison)', () => {
    expect(shouldGate(0.5, 0.5)).toBe(true)
  })

  it('returns true when rate exceeds threshold', () => {
    expect(shouldGate(0.7, 0.5)).toBe(true)
  })

  it('returns false when threshold === 1.0 (gate disabled short-circuit)', () => {
    expect(shouldGate(1.0, 1.0)).toBe(false)
  })

  it('returns false when threshold === 1.0 even at rate 0.99', () => {
    expect(shouldGate(0.99, 1.0)).toBe(false)
  })

  it('returns true when rate 1.0 meets non-disabling threshold 0.99', () => {
    expect(shouldGate(1.0, 0.99)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// formatErrorExcerpt
// ---------------------------------------------------------------------------

describe('formatErrorExcerpt', () => {
  it('returns empty string for undefined', () => {
    expect(formatErrorExcerpt(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(formatErrorExcerpt('')).toBe('')
  })

  it('returns single line unchanged', () => {
    expect(formatErrorExcerpt('Single line')).toBe('Single line')
  })

  it('returns first line when it is shorter than last-200-chars', () => {
    expect(formatErrorExcerpt('First line\nSecond line\nThird')).toBe('First line')
  })

  it('returns last 200 chars for a 250-char single-line input (last-200 is shorter than full first line)', () => {
    const input = 'A'.repeat(250)
    const result = formatErrorExcerpt(input)
    expect(result).toBe(input.slice(-200))
    expect(result.length).toBe(200)
  })

  it('returns first line when first line is 5 chars and total > 200', () => {
    const longRest = '\n' + 'B'.repeat(250)
    const input = 'Long' + longRest
    expect(formatErrorExcerpt(input)).toBe('Long')
  })
})

// ---------------------------------------------------------------------------
// buildWaveSnapshot
// ---------------------------------------------------------------------------

describe('buildWaveSnapshot', () => {
  it('only counts finalState === "failed" toward failedTasks', () => {
    const results = [
      mkResult('a', 'failed', 'error A'),
      mkResult('b', 'rejected'),
      mkResult('c', 'escalated'),
      mkResult('d', 'redirected'),
      mkResult('e', 'queued'),
      mkResult('f', 'approved'),
    ]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.failedTasks.length).toBe(1)
    expect(snap.failedTasks[0].id).toBe('a')
  })

  it('failedTasks items have { id, errorExcerpt } shape', () => {
    const results = [mkResult('task-1', 'failed', 'Something went wrong')]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.failedTasks[0]).toMatchObject({ id: 'task-1', errorExcerpt: 'Something went wrong' })
  })

  it('totalTasks counts ALL results passed in (wave batch size)', () => {
    const results = [
      mkResult('a', 'failed'),
      mkResult('b', 'approved'),
      mkResult('c', 'approved'),
    ]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.totalTasks).toBe(3)
  })

  it('rate = computeFailureRate(failedTasks.length, totalTasks)', () => {
    const results = [
      mkResult('a', 'failed'),
      mkResult('b', 'failed'),
      mkResult('c', 'approved'),
      mkResult('d', 'approved'),
      mkResult('e', 'approved'),
    ]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.rate).toBeCloseTo(2 / 5)
  })

  it('errorExcerpt uses formatErrorExcerpt from TaskResult.error', () => {
    const results = [mkResult('t1', 'failed', 'Line1\nLine2')]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.failedTasks[0].errorExcerpt).toBe('Line1')
  })

  it('errorExcerpt is empty string when TaskResult.error is undefined', () => {
    const results = [mkResult('t1', 'failed')]
    const snap = buildWaveSnapshot(1, results, 0.5)
    expect(snap.failedTasks[0].errorExcerpt).toBe('')
  })

  describe('formatInspection()', () => {
    it('returns header + one line per failed task', () => {
      const results = [
        mkResult('task-a', 'failed', 'error A'),
        mkResult('task-b', 'failed', 'error B'),
      ]
      const snap = buildWaveSnapshot(2, results, 0.5)
      const text = snap.formatInspection()
      expect(text).toContain('Failed tasks in wave 2:')
      expect(text).toContain('[task-a] error A')
      expect(text).toContain('[task-b] error B')
    })

    it('returns "No failed tasks in wave N." when failedTasks is empty', () => {
      const results = [mkResult('a', 'approved')]
      const snap = buildWaveSnapshot(3, results, 0.5)
      expect(snap.formatInspection()).toBe('No failed tasks in wave 3.')
    })
  })

  describe('snapshot immutability', () => {
    it('failedTasks array is frozen — push throws in strict mode', () => {
      const results = [mkResult('x', 'failed', 'oops')]
      const snap = buildWaveSnapshot(1, results, 0.5)
      expect(() => {
        ;(snap.failedTasks as FailedTaskInfo[]).push({ id: 'extra', errorExcerpt: '' })
      }).toThrow()
    })

    it('mutating the source array does not affect the snapshot', () => {
      const mutable: TaskResult[] = [mkResult('x', 'failed', 'original')]
      const snap = buildWaveSnapshot(1, mutable, 0.5)
      // Clear source array
      mutable.length = 0
      // Snapshot should still have the original task
      expect(snap.failedTasks.length).toBe(1)
      expect(snap.totalTasks).toBe(1)
    })
  })
})
