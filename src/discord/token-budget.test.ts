/**
 * Phase 56 (BUDGET-01): Tests for DiscordTokenBudget.
 *
 * Uses spyOn only — no mock.module (per CLAUDE.md).
 * HOME env is redirected to a temp dir in beforeEach so JSONL writes
 * don't touch ~/.telemachus in CI or dev.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordTokenBudget } from './token-budget.js'

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpHome: string
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tmpHome = await mkdtemp(join(tmpdir(), 'kc-budget-test-'))
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read all JSONL lines from today's budget file and parse them. */
async function readBudgetLines(): Promise<Array<Record<string, unknown>>> {
  const today = new Date().toISOString().slice(0, 10)
  const filePath = join(tmpHome, '.telemachus', 'discord-budget', `${today}.jsonl`)
  try {
    const content = await readFile(filePath, 'utf8')
    return content
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscordTokenBudget', () => {
  it('new user starts at usedToday=0 with resetAt = next UTC midnight', () => {
    const now = Date.UTC(2026, 3, 15, 10, 0, 0)  // 10:00 UTC on 2026-04-15
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000, now: () => now })
    const state = budget.getState('user-1')

    expect(state.usedToday).toBe(0)
    expect(state.dailyTokens).toBe(1_000)
    // resetAt should be 2026-04-16 00:00:00 UTC
    expect(state.resetAt).toBe(Date.UTC(2026, 3, 16, 0, 0, 0))
  })

  it('checkBudget returns ok when usage is below limit', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000 })
    expect(budget.checkBudget('user-1', 500)).toBe('ok')
  })

  it('recordUsage accumulates across turns', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 10_000 })
    budget.recordUsage('user-1', 1_000)
    budget.recordUsage('user-1', 2_000)
    expect(budget.getState('user-1').usedToday).toBe(3_000)
  })

  it('checkBudget returns exceeded when estimate would cross limit', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000 })
    budget.recordUsage('user-1', 800)
    // 800 used + 300 estimate = 1100 > 1000
    expect(budget.checkBudget('user-1', 300)).toBe('exceeded')
  })

  it('draining past limit makes next checkBudget return exceeded', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 500 })
    budget.recordUsage('user-1', 500)
    // Exactly at limit — next token tips it over
    expect(budget.checkBudget('user-1', 1)).toBe('exceeded')
  })

  it('resets usedToday to 0 at UTC midnight and next check returns ok', () => {
    let nowMs = Date.UTC(2026, 3, 15, 23, 59, 0)  // 23:59 UTC
    const budget = new DiscordTokenBudget({ dailyTokens: 100, now: () => nowMs })

    budget.recordUsage('user-1', 100)
    expect(budget.checkBudget('user-1', 1)).toBe('exceeded')

    // Advance past midnight
    const stateBeforeReset = budget.getState('user-1')
    nowMs = stateBeforeReset.resetAt + 1

    // Next check should reset then return ok (estimate=1, budget=100)
    expect(budget.checkBudget('user-1', 1)).toBe('ok')
    expect(budget.getState('user-1').usedToday).toBe(0)
  })

  it('defensive copy — mutating getState result does not affect subsequent checks', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000 })
    budget.recordUsage('user-1', 300)

    const state = budget.getState('user-1')
    state.usedToday = 9_999  // mutate copy

    // Internal state unchanged
    expect(budget.getState('user-1').usedToday).toBe(300)
    expect(budget.checkBudget('user-1', 1)).toBe('ok')
  })

  it('JSONL sidecar appends one line per event', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000 })

    budget.checkBudget('user-jsonl', 100)   // check_ok
    budget.recordUsage('user-jsonl', 100)   // record_usage
    budget.checkBudget('user-jsonl', 950)   // check_exceeded (100 + 950 > 1000)

    // Allow fire-and-forget promises to settle
    await new Promise((r) => setTimeout(r, 50))

    const lines = await readBudgetLines()
    const userLines = lines.filter((l) => l['userId'] === 'user-jsonl')

    // At minimum: check_ok, record_usage, check_exceeded
    expect(userLines.length).toBeGreaterThanOrEqual(3)

    const events = userLines.map((l) => l['event'])
    expect(events).toContain('check_ok')
    expect(events).toContain('record_usage')
    expect(events).toContain('check_exceeded')

    // Verify record shape
    const firstLine = userLines[0]
    expect(typeof firstLine['ts']).toBe('string')
    expect(typeof firstLine['usedToday']).toBe('number')
    expect(typeof firstLine['dailyTokens']).toBe('number')
  })

  it('tracks multiple users independently', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000 })
    budget.recordUsage('alice', 900)
    budget.recordUsage('bob', 100)

    expect(budget.getState('alice').usedToday).toBe(900)
    expect(budget.getState('bob').usedToday).toBe(100)

    // alice exceeded, bob fine
    expect(budget.checkBudget('alice', 200)).toBe('exceeded')
    expect(budget.checkBudget('bob', 200)).toBe('ok')
  })
})
