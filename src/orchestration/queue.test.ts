import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskQueue, detectCycle } from './queue.js'
import type { QueueEntry } from './queue.js'
import { runDir } from './event-log.js'

describe('TaskQueue', () => {
  let tmpHome: string
  let originalHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'queue-test-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    await rm(tmpHome, { recursive: true, force: true })
  })

  describe('enqueue / getAll', () => {
    it('enqueue adds entry and getAll returns it', () => {
      const queue = new TaskQueue('run-1')
      const entry: QueueEntry = { taskId: 'task-a', state: 'queued', configIndex: 0 }

      queue.enqueue(entry)

      const all = queue.getAll()
      expect(all).toHaveLength(1)
      expect(all[0].taskId).toBe('task-a')
      expect(all[0].state).toBe('queued')
    })

    it('enqueue multiple entries and getAll returns all in order', () => {
      const queue = new TaskQueue('run-2')
      const entries: QueueEntry[] = [
        { taskId: 'task-a', state: 'queued', configIndex: 0 },
        { taskId: 'task-b', state: 'queued', configIndex: 1 },
        { taskId: 'task-c', state: 'queued', configIndex: 2 },
      ]

      for (const entry of entries) {
        queue.enqueue(entry)
      }

      const all = queue.getAll()
      expect(all).toHaveLength(3)
      expect(all[0].taskId).toBe('task-a')
      expect(all[1].taskId).toBe('task-b')
      expect(all[2].taskId).toBe('task-c')
    })
  })

  describe('updateState', () => {
    it('changes state for matching taskId and returns new array (immutable)', () => {
      const queue = new TaskQueue('run-3')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })

      const before = queue.getAll()
      queue.updateState('task-a', 'worker_running')
      const after = queue.getAll()

      expect(after[0].state).toBe('worker_running')
      // Immutability: original snapshot should still have old state
      expect(before[0].state).toBe('queued')
    })

    it('is a no-op for nonexistent taskId', () => {
      const queue = new TaskQueue('run-4')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })

      queue.updateState('nonexistent', 'approved')

      const all = queue.getAll()
      expect(all).toHaveLength(1)
      expect(all[0].state).toBe('queued')
    })
  })

  describe('getNextPending', () => {
    it('returns first entry with state queued', () => {
      const queue = new TaskQueue('run-5')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })
      queue.enqueue({ taskId: 'task-b', state: 'queued', configIndex: 1 })

      const next = queue.getNextPending()

      expect(next?.taskId).toBe('task-a')
    })

    it('returns undefined when no queued entries exist', () => {
      const queue = new TaskQueue('run-6')
      queue.enqueue({ taskId: 'task-a', state: 'approved', configIndex: 0 })

      const next = queue.getNextPending()

      expect(next).toBeUndefined()
    })

    it('skips non-queued entries and finds first queued', () => {
      const queue = new TaskQueue('run-7')
      queue.enqueue({ taskId: 'task-a', state: 'worker_running', configIndex: 0 })
      queue.enqueue({ taskId: 'task-b', state: 'queued', configIndex: 1 })

      const next = queue.getNextPending()

      expect(next?.taskId).toBe('task-b')
    })
  })

  describe('persist', () => {
    it('writes queue.json to the run directory', async () => {
      const queue = new TaskQueue('run-persist')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })

      // Give async persist time to complete
      await new Promise((resolve) => setTimeout(resolve, 100))

      const dir = runDir('run-persist')
      const content = await readFile(join(dir, 'queue.json'), 'utf8')
      const parsed = JSON.parse(content) as QueueEntry[]

      expect(parsed).toHaveLength(1)
      expect(parsed[0].taskId).toBe('task-a')
    })
  })

  describe('concurrent updateState calls', () => {
    it('10 concurrent updateState calls on distinct taskIds all persist to queue.json', async () => {
      const queue = new TaskQueue('run-concurrent-distinct')
      // Enqueue 10 tasks
      for (let i = 0; i < 10; i++) {
        queue.enqueue({ taskId: `task-${i}`, state: 'queued', configIndex: i })
      }
      // Wait for initial persist
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Fire 10 concurrent state updates on distinct taskIds
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          Promise.resolve(queue.updateState(`task-${i}`, 'worker_running')),
        ),
      )
      // Wait for async persist to complete
      await new Promise((resolve) => setTimeout(resolve, 200))

      const dir = runDir('run-concurrent-distinct')
      const content = await readFile(join(dir, 'queue.json'), 'utf8')
      const parsed = JSON.parse(content) as QueueEntry[]

      // All 10 entries must be present and have updated state
      expect(parsed).toHaveLength(10)
      for (const entry of parsed) {
        expect(entry.state).toBe('worker_running')
      }
    })

    it('5 concurrent updateState calls on the SAME taskId leave queue.json in valid state', async () => {
      const queue = new TaskQueue('run-concurrent-same')
      queue.enqueue({ taskId: 'task-shared', state: 'queued', configIndex: 0 })
      await new Promise((resolve) => setTimeout(resolve, 100))

      const states: Array<'worker_running' | 'review_pending' | 'reviewing' | 'approved' | 'queued'> = [
        'worker_running', 'review_pending', 'reviewing', 'approved', 'queued',
      ]

      // Fire all 5 concurrently — last write wins
      await Promise.all(states.map((state) => Promise.resolve(queue.updateState('task-shared', state))))
      await new Promise((resolve) => setTimeout(resolve, 200))

      const dir = runDir('run-concurrent-same')
      const content = await readFile(join(dir, 'queue.json'), 'utf8')

      // Must be valid JSON
      expect(() => JSON.parse(content)).not.toThrow()
      const parsed = JSON.parse(content) as QueueEntry[]
      expect(parsed).toHaveLength(1)
      // State must match in-memory state
      expect(parsed[0].state).toBe(queue.getAll()[0].state)
    })
  })

  describe('dependency-aware queue', () => {
    it('no depMap — getReadyTasks returns all queued entries (backward compat)', () => {
      const queue = new TaskQueue('run-dep-1')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })
      queue.enqueue({ taskId: 'task-b', state: 'queued', configIndex: 1 })

      const ready = queue.getReadyTasks()

      expect(ready).toHaveLength(2)
      expect(ready.map((e) => e.taskId)).toContain('task-a')
      expect(ready.map((e) => e.taskId)).toContain('task-b')
    })

    it('depMap {B: [A]} — getReadyTasks returns only A; after A terminal returns B', () => {
      const depMap = new Map([
        ['task-a', [] as string[]],
        ['task-b', ['task-a']],
      ])
      const queue = new TaskQueue('run-dep-2', depMap)
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })
      queue.enqueue({ taskId: 'task-b', state: 'queued', configIndex: 1 })

      const ready1 = queue.getReadyTasks()
      expect(ready1.map((e) => e.taskId)).toEqual(['task-a'])

      queue.updateState('task-a', 'approved')

      const ready2 = queue.getReadyTasks()
      expect(ready2.map((e) => e.taskId)).toEqual(['task-b'])
    })

    it('diamond DAG (A->B, A->C, B+C->D) resolves correctly', () => {
      const depMap = new Map([
        ['task-a', [] as string[]],
        ['task-b', ['task-a']],
        ['task-c', ['task-a']],
        ['task-d', ['task-b', 'task-c']],
      ])
      const queue = new TaskQueue('run-dep-3', depMap)
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })
      queue.enqueue({ taskId: 'task-b', state: 'queued', configIndex: 1 })
      queue.enqueue({ taskId: 'task-c', state: 'queued', configIndex: 2 })
      queue.enqueue({ taskId: 'task-d', state: 'queued', configIndex: 3 })

      // Only A ready initially
      const ready1 = queue.getReadyTasks()
      expect(ready1.map((e) => e.taskId)).toEqual(['task-a'])

      // After A approved: B and C are ready
      queue.updateState('task-a', 'approved')
      const ready2 = queue.getReadyTasks()
      const ready2Ids = ready2.map((e) => e.taskId).sort()
      expect(ready2Ids).toEqual(['task-b', 'task-c'])

      // After B and C approved: D is ready
      queue.updateState('task-b', 'approved')
      queue.updateState('task-c', 'approved')
      const ready3 = queue.getReadyTasks()
      expect(ready3.map((e) => e.taskId)).toEqual(['task-d'])
    })

    it('getReadyTasks respects maxParallel — caps concurrent slots', () => {
      const queue = new TaskQueue('run-dep-4', new Map(), 2)
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ taskId: `task-${i}`, state: 'queued', configIndex: i })
      }

      // With maxParallel=2 and 0 in-flight, should return 2
      const ready1 = queue.getReadyTasks()
      expect(ready1).toHaveLength(2)

      // Mark first task as in-flight (worker_running = not queued, not terminal)
      queue.updateState('task-0', 'worker_running')

      // Now 1 in-flight, 1 slot remains
      const ready2 = queue.getReadyTasks()
      expect(ready2).toHaveLength(1)

      // Mark second in-flight too
      queue.updateState('task-1', 'worker_running')

      // 2 in-flight, 0 slots remain
      const ready3 = queue.getReadyTasks()
      expect(ready3).toHaveLength(0)
    })

    it('getTaskState returns correct state for known taskId, undefined for unknown', () => {
      const queue = new TaskQueue('run-dep-5')
      queue.enqueue({ taskId: 'task-a', state: 'queued', configIndex: 0 })
      queue.updateState('task-a', 'worker_running')

      expect(queue.getTaskState('task-a')).toBe('worker_running')
      expect(queue.getTaskState('nonexistent')).toBeUndefined()
    })

    it('detectCycle returns null for valid DAG', () => {
      const depMap = new Map([
        ['task-a', [] as string[]],
        ['task-b', ['task-a']],
        ['task-c', ['task-a']],
        ['task-d', ['task-b', 'task-c']],
      ])
      expect(detectCycle(depMap)).toBeNull()
    })

    it('detectCycle returns cycle path string for cyclic graph (A->B->C->A)', () => {
      const depMap = new Map([
        ['task-a', ['task-c']],
        ['task-b', ['task-a']],
        ['task-c', ['task-b']],
      ])
      const result = detectCycle(depMap)
      expect(result).not.toBeNull()
      expect(result).toContain('Cycle detected')
    })

    it('detectCycle handles self-referencing task (A depends on A)', () => {
      const depMap = new Map([
        ['task-a', ['task-a']],
      ])
      const result = detectCycle(depMap)
      expect(result).not.toBeNull()
      expect(result).toContain('Cycle detected')
    })

    it('detectCycle handles diamond without false positive', () => {
      const depMap = new Map([
        ['task-a', [] as string[]],
        ['task-b', ['task-a']],
        ['task-c', ['task-a']],
        ['task-d', ['task-b', 'task-c']],
      ])
      expect(detectCycle(depMap)).toBeNull()
    })
  })

  describe('fromReplay', () => {
    it('only re-queues non-terminal tasks from replayed states', () => {
      const replayedStates = new Map([
        ['task-approved', 'approved' as const],
        ['task-rejected', 'rejected' as const],
        ['task-failed', 'failed' as const],
        ['task-running', 'worker_running' as const],
        ['task-pending', 'review_pending' as const],
      ])

      const queue = TaskQueue.fromReplay('run-replay', replayedStates)
      const all = queue.getAll()

      // Terminal states should be excluded
      const taskIds = all.map((e) => e.taskId)
      expect(taskIds).not.toContain('task-approved')
      expect(taskIds).not.toContain('task-rejected')
      expect(taskIds).not.toContain('task-failed')

      // Non-terminal states should be included
      expect(taskIds).toContain('task-running')
      expect(taskIds).toContain('task-pending')
    })

    it('returns queue with zero entries for empty Map', () => {
      const queue = TaskQueue.fromReplay('run-empty', new Map())
      expect(queue.getAll()).toHaveLength(0)
    })

    it('sets configIndex to -1 for replayed entries', () => {
      const replayedStates = new Map([
        ['task-1', 'worker_running' as const],
      ])

      const queue = TaskQueue.fromReplay('run-ci', replayedStates)
      const all = queue.getAll()

      expect(all[0].configIndex).toBe(-1)
    })

    it('resets all non-terminal states to queued for clean crash recovery (P15)', () => {
      // Crash recovery: any task in worker_running, review_pending, or reviewing
      // at crash time should be reset to queued for a fresh retry attempt.
      const replayedStates = new Map([
        ['task-running', 'worker_running' as const],
        ['task-pending', 'review_pending' as const],
        ['task-reviewing', 'reviewing' as const],
      ])

      const queue = TaskQueue.fromReplay('run-crash-recovery', replayedStates)
      const all = queue.getAll()

      // All non-terminal tasks must be reset to 'queued' (not preserved)
      for (const entry of all) {
        expect(entry.state).toBe('queued')
      }
      expect(all).toHaveLength(3)
    })
  })
})
