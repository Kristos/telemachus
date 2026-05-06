import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTransition,
  replayEventLog,
  runDir,
  eventLogPath,
} from './event-log.js'
import type { TaskTransitionEvent } from './types.js'

describe('event-log', () => {
  let tmpHome: string
  let originalHome: string | undefined

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'orch-test-'))
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

  describe('runDir', () => {
    it('returns path containing .telemachus/orchestration-runs/{runId}', () => {
      const path = runDir('run-123')
      expect(path).toContain('.telemachus')
      expect(path).toContain('orchestration-runs')
      expect(path).toContain('run-123')
    })

    it('uses HOME env var', () => {
      const path = runDir('test-run')
      expect(path.startsWith(tmpHome)).toBe(true)
    })
  })

  describe('eventLogPath', () => {
    it('returns path ending in tasks.jsonl', () => {
      const path = eventLogPath('run-abc')
      expect(path.endsWith('tasks.jsonl')).toBe(true)
    })

    it('includes the runId in the path', () => {
      const path = eventLogPath('run-abc')
      expect(path).toContain('run-abc')
    })
  })

  describe('appendTransition', () => {
    it('writes a JSONL line with schemaVersion:1, taskId, fromState, toState, timestamp', async () => {
      const event: TaskTransitionEvent = {
        taskId: 'task-1',
        fromState: 'queued',
        toState: 'worker_running',
        timestamp: '2026-04-13T10:00:00.000Z',
      }

      await appendTransition('run-1', event)

      const logPath = eventLogPath('run-1')
      const content = await readFile(logPath, 'utf8')
      const line = JSON.parse(content.trim())

      expect(line.schemaVersion).toBe(1)
      expect(line.taskId).toBe('task-1')
      expect(line.fromState).toBe('queued')
      expect(line.toState).toBe('worker_running')
      expect(line.timestamp).toBe('2026-04-13T10:00:00.000Z')
    })

    it('creates run directory recursively if it does not exist', async () => {
      const event: TaskTransitionEvent = {
        taskId: 'task-2',
        fromState: 'queued',
        toState: 'worker_running',
        timestamp: new Date().toISOString(),
      }

      // run directory does not exist yet
      await appendTransition('new-run-xyz', event)

      const logPath = eventLogPath('new-run-xyz')
      const content = await readFile(logPath, 'utf8')
      expect(content.trim().length).toBeGreaterThan(0)
    })

    it('produces multiple JSONL lines for multiple calls', async () => {
      const event1: TaskTransitionEvent = {
        taskId: 'task-a',
        fromState: 'queued',
        toState: 'worker_running',
        timestamp: '2026-04-13T10:00:00.000Z',
      }
      const event2: TaskTransitionEvent = {
        taskId: 'task-a',
        fromState: 'worker_running',
        toState: 'review_pending',
        timestamp: '2026-04-13T10:01:00.000Z',
      }

      await appendTransition('run-multi', event1)
      await appendTransition('run-multi', event2)

      const logPath = eventLogPath('run-multi')
      const content = await readFile(logPath, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)

      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).toState).toBe('worker_running')
      expect(JSON.parse(lines[1]).toState).toBe('review_pending')
    })
  })

  describe('concurrent appendTransition calls', () => {
    it('20 concurrent appendTransition calls on same runId produce exactly 20 valid JSONL lines', async () => {
      const events: TaskTransitionEvent[] = Array.from({ length: 20 }, (_, i) => ({
        taskId: `task-${i}`,
        fromState: 'queued' as const,
        toState: 'worker_running' as const,
        timestamp: new Date().toISOString(),
      }))

      // Fire all 20 concurrently
      await Promise.all(events.map((event) => appendTransition('run-concurrent', event)))

      const logPath = eventLogPath('run-concurrent')
      const content = await readFile(logPath, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)

      // Must have exactly 20 lines
      expect(lines).toHaveLength(20)

      // Each line must be valid parseable JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow()
        const parsed = JSON.parse(line) as { taskId: string; schemaVersion: number }
        expect(parsed.schemaVersion).toBe(1)
        expect(typeof parsed.taskId).toBe('string')
      }
    })
  })

  describe('replayEventLog', () => {
    it('returns empty Map for a nonexistent file (fresh run)', async () => {
      const states = await replayEventLog('nonexistent-run-id')
      expect(states.size).toBe(0)
    })

    it('reconstructs latest state per taskId from multiple transitions', async () => {
      const events: TaskTransitionEvent[] = [
        { taskId: 'task-1', fromState: 'queued', toState: 'worker_running', timestamp: '2026-04-13T10:00:00.000Z' },
        { taskId: 'task-2', fromState: 'queued', toState: 'worker_running', timestamp: '2026-04-13T10:00:01.000Z' },
        { taskId: 'task-1', fromState: 'worker_running', toState: 'review_pending', timestamp: '2026-04-13T10:01:00.000Z' },
        { taskId: 'task-1', fromState: 'review_pending', toState: 'approved', timestamp: '2026-04-13T10:02:00.000Z' },
      ]

      for (const event of events) {
        await appendTransition('run-replay', event)
      }

      const states = await replayEventLog('run-replay')

      expect(states.size).toBe(2)
      expect(states.get('task-1')).toBe('approved')
      expect(states.get('task-2')).toBe('worker_running')
    })

    it('skips corrupt/invalid JSON lines without throwing', async () => {
      // Write one valid line and one corrupt line manually
      const { writeFile, mkdir } = await import('node:fs/promises')
      const dir = runDir('run-corrupt')
      await mkdir(dir, { recursive: true })
      const logPath = eventLogPath('run-corrupt')

      const validLine = JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-good',
        fromState: 'queued',
        toState: 'worker_running',
        timestamp: '2026-04-13T10:00:00.000Z',
      })
      await writeFile(logPath, `${validLine}\n{corrupt:json}\n`, 'utf8')

      // Should not throw
      const states = await replayEventLog('run-corrupt')

      expect(states.size).toBe(1)
      expect(states.get('task-good')).toBe('worker_running')
    })
  })
})
