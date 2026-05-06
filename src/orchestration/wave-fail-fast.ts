/**
 * Phase 53 (WAVE-01..04): Pure-logic helpers for the wave-boundary fail-fast gate.
 *
 * This module is intentionally free of engine/transport coupling. It exports:
 *   - Types: FailedTaskInfo, WaveSnapshot, WaveFailFastPrompt
 *   - Helpers: computeFailureRate, shouldGate, formatErrorExcerpt, buildWaveSnapshot
 *
 * Plans 02 and 03 import from here — single-source-of-truth types prevent
 * shape drift across the parallel plan executions.
 *
 * Import strategy: type-only import from engine.ts avoids a circular runtime
 * dependency (engine.ts will import from this module in Plan 02).
 */

import type { TaskResult } from './engine.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal failure info surfaced in the wave snapshot for prompt/inspection. */
export interface FailedTaskInfo {
  id: string
  errorExcerpt: string
}

/**
 * Immutable snapshot of a wave's failure state passed to WaveFailFastPrompt.
 * Built by buildWaveSnapshot; method formatInspection() is transport-agnostic.
 */
export interface WaveSnapshot {
  waveNumber: number
  totalTasks: number
  failedTasks: ReadonlyArray<FailedTaskInfo>
  threshold: number
  rate: number
  /** Returns a multi-line, transport-agnostic inspection string. */
  formatInspection(): string
}

/**
 * Transport-agnostic callback type for the wave fail-fast gate.
 * CLI supplies a readline prompt; Discord supplies a channel-reply wait.
 * Absent → engine defaults to 'continue' (preserves current behavior for
 * scripted runs and tests).
 */
export type WaveFailFastPrompt = (snapshot: WaveSnapshot) => Promise<'continue' | 'abort'>

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the failure rate for a wave.
 * Returns 0 when total === 0 (defensive — avoids NaN from 0/0).
 */
export function computeFailureRate(failed: number, total: number): number {
  if (total <= 0) return 0
  return failed / total
}

/**
 * Determine whether the fail-fast gate should trigger.
 *
 * CONTEXT decision 6: threshold >= 1.0 short-circuits — gate disabled entirely,
 * no compute overhead on runs where the user wants no interruption.
 * Gate triggers when rate >= threshold (>= per roadmap "meets or exceeds").
 */
export function shouldGate(rate: number, threshold: number): boolean {
  // threshold >= 1.0 disables the gate entirely (short-circuit)
  if (threshold >= 1.0) return false
  return rate >= threshold
}

/**
 * Extract a concise error excerpt from a TaskResult.error string.
 *
 * CONTEXT decision 4: returns the first line OR the last 200 chars of the
 * string, whichever is shorter. This keeps CLI and Discord prompts readable.
 * Returns '' for undefined/empty input.
 */
export function formatErrorExcerpt(error: string | undefined): string {
  if (!error) return ''
  const firstLine = error.split('\n')[0] ?? ''
  const lastChars = error.length > 200 ? error.slice(-200) : error
  // Whichever is shorter wins — first line is preferred for multi-line strings,
  // last-N-chars wins for extremely long single-line errors.
  return firstLine.length <= lastChars.length ? firstLine : lastChars
}

/**
 * Build an immutable WaveSnapshot from the task results of a single wave.
 *
 * CONTEXT decision 2: ONLY tasks with finalState === 'failed' contribute to
 * failedTasks. 'rejected', 'escalated', 'canceled', 'queued', and 'approved'
 * are deliberate or pending states — not cascading failures.
 *
 * totalTasks is the batch size for the wave (all results passed in); the
 * caller (Plan 02 engine glue) is responsible for scoping results to that wave.
 */
export function buildWaveSnapshot(
  waveNumber: number,
  taskResults: ReadonlyArray<TaskResult>,
  threshold: number,
): WaveSnapshot {
  // CONTEXT decision 2: ONLY finalState === 'failed' counts
  const failed: FailedTaskInfo[] = []
  for (const r of taskResults) {
    if (r.finalState === 'failed') {
      failed.push({ id: r.taskId, errorExcerpt: formatErrorExcerpt(r.error) })
    }
  }
  const totalTasks = taskResults.length
  const rate = computeFailureRate(failed.length, totalTasks)
  // Defensive copy + freeze so callers cannot mutate the snapshot's failedTasks.
  const failedTasks = Object.freeze(failed.slice()) as ReadonlyArray<FailedTaskInfo>

  return {
    waveNumber,
    totalTasks,
    failedTasks,
    threshold,
    rate,
    formatInspection(): string {
      if (failedTasks.length === 0) {
        return `No failed tasks in wave ${waveNumber}.`
      }
      const header = `Failed tasks in wave ${waveNumber}:`
      const lines = failedTasks.map((f) => `[${f.id}] ${f.errorExcerpt}`)
      return [header, ...lines].join('\n')
    },
  }
}
