/**
 * Phase 38: Orchestration event log — JSONL append + replay for crash recovery.
 *
 * Each state transition is appended as a JSONL line to
 * ~/.telemachus/orchestration-runs/{runId}/tasks.jsonl
 *
 * On crash/restart, replayEventLog reconstructs the last known state for
 * each task. Corrupt lines are skipped without throwing (best-effort replay).
 *
 * Design decisions:
 * - Separate from audit.ts (D-03): orchestration transitions are not tool calls
 * - Transitions only, no agent output (D-04)
 * - schemaVersion:1 on every line (ORCH-03)
 * - I/O errors go to stderr, never throw (same philosophy as audit.ts)
 */

import { open, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TaskTransitionEvent, OrchestrationState } from './types.js'
import { log } from '../log/logger.js'

/**
 * Per-runId promise chains for serializing concurrent JSONL appends.
 * Each runId gets its own chain so concurrent callers on different runs
 * are NOT serialized against each other — only same-runId calls are serialized.
 * Fixes PITFALLS P5: JSONL append race.
 */
const writeChains = new Map<string, Promise<void>>()

/** JSONL line shape — extends TaskTransitionEvent with schema version. */
export interface EventLogLine extends TaskTransitionEvent {
  schemaVersion: 1
}

/**
 * Returns the run directory path for the given runId.
 * Uses HOME env var when set (enables test isolation).
 */
export function runDir(runId: string): string {
  const home = process.env.HOME ?? homedir()
  return join(home, '.telemachus', 'orchestration-runs', runId)
}

/**
 * Returns the JSONL event log file path for the given runId.
 */
export function eventLogPath(runId: string): string {
  return join(runDir(runId), 'tasks.jsonl')
}

/**
 * Appends a transition event to the event log as a JSONL line.
 *
 * Creates the run directory recursively if needed. Errors are written
 * to stderr and the function returns normally (never throws).
 *
 * Concurrent calls for the same runId are serialized via a per-runId
 * promise chain (writeChains) to prevent interleaved JSONL writes (P5).
 * Concurrent calls for different runIds are fully parallel.
 */
export async function appendTransition(
  runId: string,
  event: TaskTransitionEvent,
): Promise<void> {
  const prev = writeChains.get(runId) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await mkdir(runDir(runId), { recursive: true })

      const line: EventLogLine = {
        schemaVersion: 1,
        taskId: event.taskId,
        fromState: event.fromState,
        toState: event.toState,
        timestamp: event.timestamp,
        ...(event.data !== undefined ? { data: event.data } : {}),
      }

      const logPath = eventLogPath(runId)
      const fh = await open(logPath, 'a')
      try {
        await fh.appendFile(JSON.stringify(line) + '\n', 'utf8')
        await fh.datasync()
      } finally {
        await fh.close()
      }
    })
    .catch((err) => {
      log('warn', { module: 'orchestration-event-log', runId, error: err instanceof Error ? err.message : String(err) }, 'could not append transition')
      // Never crash the orchestration engine — event log is best-effort.
    })
  writeChains.set(runId, next)
  await next
}

/**
 * Replays the event log and returns a map of taskId → latest OrchestrationState.
 *
 * On ENOENT (fresh run): returns empty Map.
 * On corrupt JSON lines: skips them with a stderr warning.
 * On other errors: warns to stderr and returns what was collected so far.
 */
export async function replayEventLog(
  runId: string,
): Promise<Map<string, OrchestrationState>> {
  const taskStates = new Map<string, OrchestrationState>()
  const logPath = eventLogPath(runId)

  try {
    const content = await readFile(logPath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)

    for (const rawLine of lines) {
      try {
        const entry = JSON.parse(rawLine) as Partial<EventLogLine>
        if (
          typeof entry.taskId === 'string' &&
          typeof entry.toState === 'string'
        ) {
          taskStates.set(entry.taskId, entry.toState as OrchestrationState)
        }
      } catch {
        log('warn', { module: 'orchestration-event-log', runId }, 'skipping corrupt event log line')
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log('warn', { module: 'orchestration-event-log', runId, error: err instanceof Error ? err.message : String(err) }, 'could not read event log')
    }
    // ENOENT = fresh run, return empty map
  }

  return taskStates
}

/**
 * Extended replay that also accumulates the total reviewer cost from approved,
 * rejected, and redirected transitions. Used after a crash to restore the
 * reviewer budget baseline.
 */
export async function replayEventLogFull(runId: string): Promise<{
  states: Map<string, OrchestrationState>
  accumulatedReviewerCost: number
}> {
  const states = new Map<string, OrchestrationState>()
  let accumulatedReviewerCost = 0
  const logPath = eventLogPath(runId)
  const reviewerTerminals = new Set(['approved', 'rejected', 'redirected'])

  try {
    const content = await readFile(logPath, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)

    for (const rawLine of lines) {
      try {
        const entry = JSON.parse(rawLine) as Partial<EventLogLine>
        if (
          typeof entry.taskId === 'string' &&
          typeof entry.toState === 'string'
        ) {
          states.set(entry.taskId, entry.toState as OrchestrationState)
          if (
            reviewerTerminals.has(entry.toState) &&
            typeof entry.data?.reviewerCostUsd === 'number'
          ) {
            accumulatedReviewerCost += entry.data.reviewerCostUsd as number
          }
        }
      } catch {
        log('warn', { module: 'orchestration-event-log', runId }, 'skipping corrupt event log line during full replay')
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log('warn', { module: 'orchestration-event-log', runId, error: err instanceof Error ? err.message : String(err) }, 'could not read event log for full replay')
    }
  }

  return { states, accumulatedReviewerCost }
}
