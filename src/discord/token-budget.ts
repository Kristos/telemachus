/**
 * Phase 56 (BUDGET-01): Per-user Discord token budget tracker.
 *
 * Tracks daily token usage per Discord user ID. On `checkBudget`, returns
 * 'exceeded' when the user's `usedToday + estimate` would exceed `dailyTokens`.
 * Resets at UTC midnight automatically (no cron — checked lazily on each call).
 *
 * Persistence: JSONL sidecar at ~/.telemachus/discord-budget/YYYY-MM-DD.jsonl
 * via the shared JsonlWriter class (HYG-03). Write failures are swallowed to
 * stderr — budget recording is best-effort.
 *
 * Phase 65 (HYG-03): mkdir→open→appendFile→datasync→close pipeline delegated
 * to the shared JsonlWriter class; public appendBudgetEntry signature unchanged.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsonlWriter } from './jsonl-writer.js'

// ── JSONL record ──────────────────────────────────────────────────────────────

export interface BudgetRecord {
  ts: string
  userId: string
  event: 'check_ok' | 'check_exceeded' | 'record_usage' | 'reset'
  usedToday: number
  dailyTokens: number
}

// ── File paths (process.env.HOME respected so tests can redirect) ─────────────

export function budgetDir(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, '.telemachus', 'discord-budget')
}

export function budgetPath(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD UTC
  return join(budgetDir(), `${date}.jsonl`)
}

// Module-scoped writer. resolveDir/resolvePath are callbacks so tests that
// redirect HOME via process.env between calls still hit the redirected path.
const budgetWriter = new JsonlWriter({
  resolveDir: budgetDir,
  resolvePath: budgetPath,
  module: 'token-budget',
  warnContext: (r) => {
    const rec = r as BudgetRecord
    return { userId: rec.userId, event: rec.event }
  },
})

/**
 * Append a budget event record to the date-partitioned JSONL file.
 * Fire-and-forget safe — errors go to logger, never throws.
 */
export async function appendBudgetEntry(record: BudgetRecord): Promise<void> {
  await budgetWriter.append(record)
}

// ── Internal per-user state ───────────────────────────────────────────────────

interface UserBudgetEntry {
  dailyTokens: number
  usedToday: number
  resetAt: number  // epoch ms of next UTC midnight
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the epoch ms of the next UTC midnight strictly after `nowMs`.
 * If `nowMs` is exactly at midnight, returns the midnight 24h later.
 */
function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  // Move to next day UTC midnight
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

// ── DiscordTokenBudget ────────────────────────────────────────────────────────

export class DiscordTokenBudget {
  private readonly dailyTokens: number
  private readonly nowFn: () => number
  private readonly entries = new Map<string, UserBudgetEntry>()

  constructor(opts: { dailyTokens: number; now?: () => number }) {
    this.dailyTokens = opts.dailyTokens
    this.nowFn = opts.now ?? (() => Date.now())
  }

  /**
   * Ensure an entry exists for `userId`, creating it if absent.
   * Also performs lazy reset: if now >= resetAt, zeros usedToday and advances resetAt.
   */
  private ensure(userId: string): UserBudgetEntry {
    const now = this.nowFn()
    let entry = this.entries.get(userId)
    if (!entry) {
      entry = {
        dailyTokens: this.dailyTokens,
        usedToday: 0,
        resetAt: nextUtcMidnight(now),
      }
      this.entries.set(userId, entry)
    } else if (now >= entry.resetAt) {
      // Reset window — mutate in-place (internal Map state, not external API)
      entry.usedToday = 0
      entry.resetAt = nextUtcMidnight(now)
      void appendBudgetEntry({
        ts: new Date(now).toISOString(),
        userId,
        event: 'reset',
        usedToday: 0,
        dailyTokens: this.dailyTokens,
      })
    }
    return entry
  }

  /**
   * Check whether `userId` has enough budget for `estimate` more tokens.
   * Returns 'ok' or 'exceeded'. Does NOT consume the budget — call recordUsage
   * after the turn completes.
   */
  checkBudget(userId: string, estimate: number): 'ok' | 'exceeded' {
    const entry = this.ensure(userId)
    const ts = new Date(this.nowFn()).toISOString()

    if (entry.usedToday + estimate > this.dailyTokens) {
      void appendBudgetEntry({
        ts,
        userId,
        event: 'check_exceeded',
        usedToday: entry.usedToday,
        dailyTokens: this.dailyTokens,
      })
      return 'exceeded'
    }

    void appendBudgetEntry({
      ts,
      userId,
      event: 'check_ok',
      usedToday: entry.usedToday,
      dailyTokens: this.dailyTokens,
    })
    return 'ok'
  }

  /**
   * Record actual token usage after a successful turn.
   * Increments usedToday for `userId`.
   */
  recordUsage(userId: string, tokens: number): void {
    const entry = this.ensure(userId)
    entry.usedToday += tokens
    void appendBudgetEntry({
      ts: new Date(this.nowFn()).toISOString(),
      userId,
      event: 'record_usage',
      usedToday: entry.usedToday,
      dailyTokens: this.dailyTokens,
    })
  }

  /**
   * Returns a defensive copy of the current budget state for `userId`.
   * Creating the entry if not yet seen (usedToday = 0, resetAt = next UTC midnight).
   */
  getState(userId: string): { dailyTokens: number; usedToday: number; resetAt: number } {
    const entry = this.ensure(userId)
    return { ...entry }
  }
}
