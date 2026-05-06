import { describe, it, expect } from 'bun:test'
import { checkWorkerBudget, checkReviewerBudget, ReviewerCostAccumulator } from './budget.js'
import { createSession, addTurn } from '../usage/tracker.js'
import type { UsageSession } from '../usage/tracker.js'
import type { TaskConfig, OrchestrationRunConfig } from './config-schema.js'

// Helper to build a minimal TaskConfig
function makeTask(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 'task-1',
    prompt: 'do something',
    escalation: 'require_human',
    ...overrides,
  }
}

// Helper to build a minimal OrchestrationRunConfig
function makeRunConfig(overrides: Partial<OrchestrationRunConfig> = {}): OrchestrationRunConfig {
  return {
    schemaVersion: 1,
    maxWorkerTurns: 20,
    maxRetries: 2,
    tasks: [makeTask()],
    ...overrides,
  }
}

// Helper to build a UsageSession with a given turn count
function sessionWithTurns(turnCount: number): UsageSession {
  let session = createSession()
  for (let i = 0; i < turnCount; i++) {
    session = addTurn(
      session,
      { inputTokens: 100, outputTokens: 50 },
      'gpt-4o-mini',
    )
  }
  return session
}

describe('checkWorkerBudget', () => {
  it('returns null when turnCount (5) < maxWorkerTurns (20)', () => {
    const task = makeTask()
    const runConfig = makeRunConfig({ maxWorkerTurns: 20 })
    const session = sessionWithTurns(5)

    const result = checkWorkerBudget(task, runConfig, session)

    expect(result).toBeNull()
  })

  it('returns BudgetBlock with kind max_worker_turns when turnCount (20) >= maxWorkerTurns (20)', () => {
    const task = makeTask()
    const runConfig = makeRunConfig({ maxWorkerTurns: 20 })
    const session = sessionWithTurns(20)

    const result = checkWorkerBudget(task, runConfig, session)

    expect(result).not.toBeNull()
    expect(result?.kind).toBe('max_worker_turns')
    expect(result?.limit).toBe(20)
    expect(result?.used).toBe(20)
  })

  it('returns BudgetBlock when turnCount exceeds maxWorkerTurns', () => {
    const task = makeTask()
    const runConfig = makeRunConfig({ maxWorkerTurns: 10 })
    const session = sessionWithTurns(15)

    const result = checkWorkerBudget(task, runConfig, session)

    expect(result?.kind).toBe('max_worker_turns')
    expect(result?.limit).toBe(10)
    expect(result?.used).toBe(15)
  })

  it('uses per-task maxWorkerTurns when set, overriding run default', () => {
    const task = makeTask({ maxWorkerTurns: 5 })
    const runConfig = makeRunConfig({ maxWorkerTurns: 20 })
    const session = sessionWithTurns(5)

    // Should block because task limit is 5
    const result = checkWorkerBudget(task, runConfig, session)

    expect(result?.kind).toBe('max_worker_turns')
    expect(result?.limit).toBe(5)
  })

  it('falls back to run maxWorkerTurns when task does not have its own', () => {
    const task = makeTask() // no maxWorkerTurns
    const runConfig = makeRunConfig({ maxWorkerTurns: 3 })
    const session = sessionWithTurns(2)

    // Should not block (2 < 3)
    const result = checkWorkerBudget(task, runConfig, session)

    expect(result).toBeNull()
  })
})

describe('checkReviewerBudget', () => {
  it('returns null when maxOpusDollars is undefined (unlimited)', () => {
    const runConfig = makeRunConfig({ maxOpusDollars: undefined })

    const result = checkReviewerBudget(runConfig, 999.99)

    expect(result).toBeNull()
  })

  it('returns null when accumulated cost (0.50) < maxOpusDollars (1.00)', () => {
    const runConfig = makeRunConfig({ maxOpusDollars: 1.00 })

    const result = checkReviewerBudget(runConfig, 0.50)

    expect(result).toBeNull()
  })

  it('returns BudgetBlock when accumulated cost (1.00) >= maxOpusDollars (1.00)', () => {
    const runConfig = makeRunConfig({ maxOpusDollars: 1.00 })

    const result = checkReviewerBudget(runConfig, 1.00)

    expect(result).not.toBeNull()
    expect(result?.kind).toBe('max_opus_dollars')
    expect(result?.limit).toBe(1.00)
    expect(result?.used).toBe(1.00)
  })

  it('returns BudgetBlock when accumulated cost exceeds maxOpusDollars', () => {
    const runConfig = makeRunConfig({ maxOpusDollars: 0.50 })

    const result = checkReviewerBudget(runConfig, 0.75)

    expect(result?.kind).toBe('max_opus_dollars')
    expect(result?.limit).toBe(0.50)
    expect(result?.used).toBe(0.75)
  })
})

describe('ReviewerCostAccumulator', () => {
  it('sequential adds produce correct total', async () => {
    const acc = new ReviewerCostAccumulator()
    await acc.add(0.50)
    await acc.add(0.30)
    expect(acc.total).toBe(0.80)
  })

  it('initial value sets baseline total', () => {
    const acc = new ReviewerCostAccumulator(1.00)
    expect(acc.total).toBe(1.00)
  })

  it('10 concurrent .add() calls with values summing to 5.00 produce total === 5.00', async () => {
    const acc = new ReviewerCostAccumulator()
    // 10 adds of 0.50 = 5.00
    await Promise.all(Array.from({ length: 10 }, () => acc.add(0.50)))
    expect(acc.total).toBeCloseTo(5.00, 10)
  })

  it('checkReviewerBudget accepts ReviewerCostAccumulator as costSource', async () => {
    const runConfig = makeRunConfig({ maxOpusDollars: 1.00 })
    const acc = new ReviewerCostAccumulator()
    await acc.add(1.00)

    const result = checkReviewerBudget(runConfig, acc)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('max_opus_dollars')
    expect(result?.used).toBe(1.00)
  })

  it('checkReviewerBudget still accepts a plain number (backward compat)', () => {
    const runConfig = makeRunConfig({ maxOpusDollars: 1.00 })
    const result = checkReviewerBudget(runConfig, 0.50)
    expect(result).toBeNull()
  })
})

describe('BUD-03: session isolation', () => {
  it('two createSession() calls return distinct objects (not same reference)', () => {
    const session1 = createSession()
    const session2 = createSession()

    expect(session1).not.toBe(session2)
  })

  it('mutating one session via addTurn does not affect the other', () => {
    const session1 = createSession()
    const session2 = createSession()

    const updated = addTurn(
      session1,
      { inputTokens: 100, outputTokens: 50 },
      'gpt-4o-mini',
    )

    // session1 is immutable — original unchanged
    expect(session1.turnCount).toBe(0)
    // session2 is unaffected
    expect(session2.turnCount).toBe(0)
    // only the returned value changed
    expect(updated.turnCount).toBe(1)
  })
})
