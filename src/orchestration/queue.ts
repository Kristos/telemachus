/**
 * Phase 38: In-memory task queue with write-through disk persistence.
 *
 * The queue is the execution spine of the orchestration engine. Every state
 * mutation is persisted to disk immediately (write-through), so a crash at
 * any point leaves a recoverable snapshot.
 *
 * After a crash, TaskQueue.fromReplay() reconstructs the queue from the
 * event log by excluding tasks that have already reached terminal states.
 *
 * Immutability: updateState rebuilds the entries array with a spread copy
 * of the modified entry, per project coding conventions.
 *
 * Persistence errors go to stderr and never throw — disk failure should not
 * crash the orchestration engine.
 *
 * Phase 41-02: Extended with dependency-aware dispatch:
 * - getReadyTasks() respects dependsOn edges and maxParallel cap
 * - getTaskState() returns the current state of a task by ID
 * - detectCycle() pure utility — detects circular dependsOn references
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL_STATES, type OrchestrationState } from './types.js'
import { runDir } from './event-log.js'
import { log } from '../log/logger.js'

/** A single entry in the task execution queue. */
export interface QueueEntry {
  taskId: string
  state: OrchestrationState
  /**
   * Index into OrchestrationRunConfig.tasks[]. Set to -1 for entries
   * reconstructed from crash replay (Phase 39 will resolve from config).
   */
  configIndex: number
}

/**
 * Detect cycles in a dependency map using DFS.
 * Returns null if no cycle found, or a descriptive string if cycle exists.
 *
 * Pure utility function — does not depend on queue state.
 */
export function detectCycle(depMap: Map<string, string[]>): string | null {
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(node: string, path: string[]): string | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node)
      return `Cycle detected: ${[...path.slice(cycleStart), node].join(' -> ')}`
    }
    if (visited.has(node)) return null
    visited.add(node)
    inStack.add(node)
    for (const dep of depMap.get(node) ?? []) {
      const result = dfs(dep, [...path, node])
      if (result) return result
    }
    inStack.delete(node)
    return null
  }

  for (const node of depMap.keys()) {
    const result = dfs(node, [])
    if (result) return result
  }
  return null
}

/** In-memory task queue with write-through disk persistence. */
export class TaskQueue {
  private entries: QueueEntry[]
  private readonly runId: string
  /**
   * Serializes concurrent persist() calls via promise chaining.
   * Fixes PITFALLS P6: concurrent queue write collision.
   * In-memory mutations are still synchronous (JS single-threaded),
   * so the last synchronous mutation before the next microtask wins.
   */
  private persistChain: Promise<void> = Promise.resolve()
  /**
   * Dependency map: taskId -> list of task IDs that must be terminal
   * before this task can be dispatched.
   * Phase 41-02: supports dependency-aware dispatch in getReadyTasks().
   */
  private readonly depMap: ReadonlyMap<string, readonly string[]>
  /**
   * Maximum number of tasks that may be in-flight simultaneously.
   * Absent = no cap (all ready tasks returned by getReadyTasks).
   * Phase 41-02: enforced in getReadyTasks() slot counting.
   */
  private readonly maxParallel: number | undefined

  constructor(runId: string, depMap?: Map<string, string[]>, maxParallel?: number) {
    this.runId = runId
    this.entries = []
    this.depMap = depMap ?? new Map()
    this.maxParallel = maxParallel
  }

  /**
   * Add an entry to the end of the queue and persist to disk.
   */
  enqueue(entry: QueueEntry): void {
    this.entries = [...this.entries, entry]
    void this.persist()
  }

  /**
   * Update the state of the entry with the given taskId (immutable rebuild).
   * If taskId is not found, this is a no-op.
   * Persists to disk after the update.
   */
  updateState(taskId: string, state: OrchestrationState): void {
    this.entries = this.entries.map((entry) =>
      entry.taskId === taskId ? { ...entry, state } : entry,
    )
    void this.persist()
  }

  /** Returns the current entries array (readonly view). */
  getAll(): readonly QueueEntry[] {
    return this.entries
  }

  /**
   * Returns the current state of the task with the given ID,
   * or undefined if the task is not in the queue.
   */
  getTaskState(taskId: string): OrchestrationState | undefined {
    return this.entries.find((e) => e.taskId === taskId)?.state
  }

  /**
   * Returns the first entry with state === 'queued', or undefined if none.
   */
  getNextPending(): QueueEntry | undefined {
    return this.entries.find((entry) => entry.state === 'queued')
  }

  /**
   * Returns all queued entries whose dependsOn task IDs have ALL reached
   * terminal states. Respects maxParallel by counting currently in-flight
   * tasks (non-queued, non-terminal).
   *
   * "In-flight" = state is not 'queued' and not in TERMINAL_STATES.
   * (e.g., worker_running, review_pending, reviewing)
   *
   * Phase 41-02: dependency-aware dispatch for Phase 42 parallel fan-out.
   */
  getReadyTasks(): QueueEntry[] {
    const inFlightCount = this.entries.filter(
      (e) => e.state !== 'queued' && !TERMINAL_STATES.has(e.state),
    ).length

    const availableSlots =
      this.maxParallel !== undefined
        ? Math.max(0, this.maxParallel - inFlightCount)
        : Infinity

    if (availableSlots === 0) return []

    const ready = this.entries.filter((entry) => {
      if (entry.state !== 'queued') return false
      const deps = this.depMap.get(entry.taskId) ?? []
      return deps.every((depId) => {
        const depState = this.getTaskState(depId)
        return depState !== undefined && TERMINAL_STATES.has(depState)
      })
    })

    return ready.slice(0, availableSlots === Infinity ? undefined : availableSlots)
  }

  /**
   * Persist the current queue to {runDir}/queue.json.
   * Errors go to stderr, never throw.
   *
   * Serialized via persistChain to prevent concurrent writes from
   * producing a corrupt or partially-written queue.json (P6).
   */
  private async persist(): Promise<void> {
    const work = async () => {
      try {
        const dir = runDir(this.runId)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, 'queue.json'),
          JSON.stringify(this.entries, null, 2),
          'utf8',
        )
      } catch (err) {
        log('warn', { module: 'orchestration-queue', runId: this.runId, error: err instanceof Error ? err.message : String(err) }, 'could not persist queue')
      }
    }
    this.persistChain = this.persistChain.then(work, work)
    await this.persistChain
  }

  /**
   * Reconstruct a queue from replayed event log state.
   *
   * Only non-terminal tasks are included — tasks that have already reached
   * approved/rejected/redirected/escalated/failed are dropped (they're done).
   *
   * configIndex is set to -1 for all replayed entries; Phase 39 will resolve
   * the correct index when it rebuilds from the run config.
   *
   * NOT async — the replay Map is computed by the caller before this is invoked.
   *
   * Phase 41-02: accepts optional depMap and maxParallel so crash recovery
   * preserves dependency resolution behavior.
   */
  static fromReplay(
    runId: string,
    replayedStates: Map<string, OrchestrationState>,
    depMap?: Map<string, string[]>,
    maxParallel?: number,
  ): TaskQueue {
    const queue = new TaskQueue(runId, depMap, maxParallel)

    for (const [taskId, state] of replayedStates) {
      if (!TERMINAL_STATES.has(state)) {
        // Crash recovery (P15): reset any in-flight state to 'queued' for a
        // clean retry. Tasks that were worker_running, review_pending, or
        // reviewing at crash time cannot be safely resumed — the worker may
        // have left the worktree in a partial state, or the reviewer may have
        // been mid-evaluation. Starting from 'queued' ensures a fresh attempt.
        queue.entries = [
          ...queue.entries,
          { taskId, state: 'queued', configIndex: -1 },
        ]
      }
    }

    return queue
  }
}
