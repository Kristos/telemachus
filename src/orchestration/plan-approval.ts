/**
 * Phase 44: Plan approval gate — transport-agnostic.
 *
 * Formats a DecomposeResult into a human-readable plan preview and gates
 * execution on an injectable confirm callback. Works for both CLI (readline)
 * and Discord (DM reply) by accepting display/confirm callbacks.
 *
 * Per CHI 2025 research: showing the plan and requiring explicit approval
 * significantly improves user trust and task success rate in agentic systems.
 *
 * DECOMP-04
 */

import type { DecomposeResult } from './decomposer.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PlanApprovalResult = 'approved' | 'rejected'

export interface PlanApprovalCallbacks {
  /** Display the formatted plan to the user (stdout, Discord message, etc.). */
  displayFn: (text: string) => Promise<void>
  /** Ask the user for approval. Returns true to approve, false to reject. */
  confirmFn: () => Promise<boolean>
}

// ---------------------------------------------------------------------------
// formatPlanPreview — pure function
// ---------------------------------------------------------------------------

/**
 * Format a DecomposeResult into a human-readable numbered plan preview.
 *
 * Output structure:
 *   Proposed Orchestration Plan (N tasks)
 *
 *   1. [task-id] prompt preview (first 80 chars)
 *      Depends on: dep-a, dep-b
 *      Rationale: "why this dependency exists"
 *   ...
 *
 *   Warnings:
 *     - warning text
 *
 *   Approve this plan? (y/n)
 */
export function formatPlanPreview(result: DecomposeResult): string {
  const { config, warnings, planText } = result

  // If the decomposer already built planText (includes rationale from raw tasks),
  // we use it directly. This avoids re-formatting without the rationale data.
  // But we also want to ensure the standard format — use planText as-is since
  // decomposer.ts builds it in the expected format.
  void config // config used for type-checking DecomposeResult

  return planText
}

// ---------------------------------------------------------------------------
// awaitPlanApproval — main gate function
// ---------------------------------------------------------------------------

/**
 * Display the plan and await user confirmation.
 *
 * Steps:
 *   1. Format the plan using formatPlanPreview
 *   2. Call displayFn with the formatted text
 *   3. Call confirmFn and return 'approved' or 'rejected'
 *
 * The callbacks are injected so CLI and Discord can both use this function
 * with their own I/O implementations.
 */
export async function awaitPlanApproval(
  result: DecomposeResult,
  callbacks: PlanApprovalCallbacks,
): Promise<PlanApprovalResult> {
  const formatted = formatPlanPreview(result)

  await callbacks.displayFn(formatted)

  const approved = await callbacks.confirmFn()
  return approved ? 'approved' : 'rejected'
}
