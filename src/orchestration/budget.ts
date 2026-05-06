/**
 * Phase 38: Budget check functions for the orchestration engine.
 *
 * Two budget types (per design decision BUD-01 through BUD-03):
 * - Worker turn budget: stops a worker agent when it hits maxWorkerTurns
 *   (GLM is cheap but can loop — turn count is the natural cap)
 * - Reviewer dollar budget: stops the reviewer loop when accumulated
 *   Opus spend hits maxOpusDollars (cross-task shared budget)
 *
 * Session isolation (BUD-03): budget checks receive pre-created UsageSession
 * objects. We NEVER import module-level tracker state — those singleton
 * functions are for the interactive CLI's /cost display only. Budget checks
 * use isolated per-agent sessions passed in as parameters.
 *
 * Checks happen BEFORE dispatching the next turn (D-06): the worker finishes
 * its current turn, then the engine evaluates the budget before launching
 * the next one. This means the worker always completes the turn it started.
 */

import type { UsageSession } from '../usage/tracker.js'
import type { TaskConfig, OrchestrationRunConfig } from './config-schema.js'

/**
 * Discriminated union describing why a budget check blocked dispatch.
 * Returned by checkWorkerBudget / checkReviewerBudget when limits are hit.
 */
export type BudgetBlock =
  | { kind: 'max_worker_turns'; limit: number; used: number }
  | { kind: 'max_opus_dollars'; limit: number; used: number }

/**
 * Atomic reviewer cost accumulator for concurrent parallel runs.
 *
 * In the serial engine (Phase 38-40), budget.reviewerCost was a plain number
 * incremented with `+=`. Under parallel execution (Phase 42), concurrent
 * processTask calls would race on that increment. This accumulator serializes
 * add() operations via a promise chain so no increment is ever lost.
 *
 * Fixes PITFALLS P8: budget drift under parallel reviewer results.
 */
export class ReviewerCostAccumulator {
  private _total: number
  private chain: Promise<void> = Promise.resolve()

  constructor(initial: number = 0) {
    this._total = initial
  }

  /** Current accumulated total (read synchronously). */
  get total(): number {
    return this._total
  }

  /**
   * Atomically add a reviewer cost. Serialized via promise chain to prevent
   * concurrent read-modify-write races across await points.
   *
   * @returns the new total after this add completes
   */
  async add(cost: number): Promise<number> {
    return new Promise<number>((resolve) => {
      this.chain = this.chain.then(() => {
        this._total += cost
        resolve(this._total)
      })
    })
  }
}

/**
 * Check whether the worker agent should be stopped before the next turn.
 *
 * Resolves the effective limit as: task.maxWorkerTurns ?? runConfig.maxWorkerTurns
 *
 * Returns a BudgetBlock if the limit is reached, null if dispatch should proceed.
 */
export function checkWorkerBudget(
  task: TaskConfig,
  runConfig: OrchestrationRunConfig,
  workerSession: UsageSession,
): BudgetBlock | null {
  const limit = task.maxWorkerTurns ?? runConfig.maxWorkerTurns
  const used = workerSession.turnCount

  if (used >= limit) {
    return { kind: 'max_worker_turns', limit, used }
  }

  return null
}

/**
 * Check whether the reviewer agent should be stopped before the next turn.
 *
 * If maxOpusDollars is undefined, the budget is unlimited — always returns null.
 * Returns a BudgetBlock if the accumulated cross-task reviewer spend hits the cap.
 *
 * Accepts either a plain number (backward-compatible) or a ReviewerCostAccumulator
 * (for use with parallel execution in Phase 42).
 *
 * @param costSource - total Opus spend, either as a number or ReviewerCostAccumulator
 */
export function checkReviewerBudget(
  runConfig: OrchestrationRunConfig,
  costSource: number | ReviewerCostAccumulator,
): BudgetBlock | null {
  if (runConfig.maxOpusDollars === undefined) {
    return null
  }

  const used = typeof costSource === 'number' ? costSource : costSource.total

  if (used >= runConfig.maxOpusDollars) {
    return {
      kind: 'max_opus_dollars',
      limit: runConfig.maxOpusDollars,
      used,
    }
  }

  return null
}
