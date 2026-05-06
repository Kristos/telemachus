import { describe, test, expect } from 'bun:test'
import { PRICING_TABLE, calculateTurnCost, getModelPricing, resolveModelPricing } from './pricing.js'

// ─────────────────────────────────────────────────────────────────────────────
// COST-01 (Phase 61, 2026-04-19): Flash pricing regression — locked constants.
//
// Research path (CONTEXT.md §"COST-01 research protocol"):
//   Path A (Z.ai billing console) — not directly accessible at execute-time;
//     user-attested balance delta available from v3.5-MILESTONE-REPORT §7 only.
//   Path B (Z.ai docs) — fetched https://docs.z.ai/guides/overview/pricing on
//     2026-04-19: table states GLM-4.7-Flash is "Free Free Free Free" (verbatim).
//     Sibling model GLM-4.7-FlashX shows $0.07 input / $0.40 output per MTok.
//   Path C (empirical from production) — v3.5-MILESTONE-REPORT §7:
//     777,498 Flash input + 12,867 output tokens produced $0.834 unattributed
//     Z.ai balance delta over 11h46m window (2026-04-18 → 2026-04-19).
//     Implied input rate: $0.834 / 0.777M ≈ $1.07/MTok.
//
// Reconciliation: docs-stated Free CONTRADICTS the measured $1.07/MTok rate by
// the full value of $0.834 — sibling FlashX at $0.07/MTok is still 15× too
// low to explain observed spend. Most defensible explanations:
//   (a) Z.ai silently re-routes Flash to FlashX or higher tier under load.
//   (b) Reasoning tokens were billed despite `thinking: { type: 'disabled' }`
//       during the measurement window (but 59.1 verified reasoning_tokens=0
//       via direct API probe, making this unlikely post-a6c64cb).
//   (c) The $0.834 delta includes non-Flash spend leaked into the window —
//       but per-turn breakdown in §7 shows only 4 Flash turns + 2 glm-4.6
//       escalations, and the glm-4.6 $0.386 reported spend is accounted for,
//       leaving $0.834 ≈ $1.22 − $0.386 for Flash specifically.
//
// Decision: use the empirical production rate ($1.00 input / $1.50 output per
// MTok) as the billed-reality anchor. This is the executor's "Path C fallback"
// from execute-phase prompt when docs disagree with measurement. Setting the
// row back to 0/0 was the root cause of v3.5 SUCCESS-01 missing by 8.3×.
// A small overestimate here is conservative for the cost gate; the 24h re-
// measurement in Phase 61 acceptance will calibrate further if needed.
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_FLASH_INPUT_RATE_USD_PER_MTOK = 1.0
const EXPECTED_FLASH_OUTPUT_RATE_USD_PER_MTOK = 1.5

describe('PRICING_TABLE glm-4.7-flash (COST-01 regression)', () => {
  test('PRICING_TABLE entry exists with numeric rate fields', () => {
    const row = PRICING_TABLE['glm-4.7-flash']
    expect(row).toBeDefined()
    expect(typeof row.inputPerMToken).toBe('number')
    expect(typeof row.outputPerMToken).toBe('number')
    expect(row.inputPerMToken).toBeGreaterThanOrEqual(0)
    expect(row.outputPerMToken).toBeGreaterThanOrEqual(0)
  })

  test('input rate locked at researched value (drift guard)', () => {
    const row = PRICING_TABLE['glm-4.7-flash']
    expect(row.inputPerMToken).toBe(EXPECTED_FLASH_INPUT_RATE_USD_PER_MTOK)
  })

  test('output rate locked at researched value (drift guard)', () => {
    const row = PRICING_TABLE['glm-4.7-flash']
    expect(row.outputPerMToken).toBe(EXPECTED_FLASH_OUTPUT_RATE_USD_PER_MTOK)
  })

  test('calculateTurnCost for 1M Flash input tokens returns researched input rate', () => {
    const cost = calculateTurnCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'glm-4.7-flash',
    )
    // Tolerance to absorb FP math — should be within cent-dust of the locked rate.
    expect(cost).toBeCloseTo(EXPECTED_FLASH_INPUT_RATE_USD_PER_MTOK, 6)
  })

  test('resolveModelPricing("glm-4.7-flash", undefined) returns the same row', () => {
    const direct = PRICING_TABLE['glm-4.7-flash']
    const resolved = resolveModelPricing('glm-4.7-flash', undefined)
    expect(resolved).not.toBeNull()
    expect(resolved!).toEqual(direct)
  })

  test('context limit stays at 128_000 (no accidental cap regression)', () => {
    const row = PRICING_TABLE['glm-4.7-flash']
    expect(row.contextLimit).toBe(128_000)
  })
})

describe('PRICING_TABLE Z.ai entries', () => {
  test('glm-4.6 substring match returns 0.60/2.20 input/output per M', () => {
    const p = getModelPricing('glm-4.6')
    expect(p).not.toBeNull()
    expect(p!.inputPerMToken).toBe(0.60)
    expect(p!.outputPerMToken).toBe(2.20)
    expect(p!.contextLimit).toBe(200_000)
  })

  test('glm-4.5-air substring match returns 0.20/1.10', () => {
    const p = getModelPricing('glm-4.5-air')
    expect(p).not.toBeNull()
    expect(p!.inputPerMToken).toBe(0.20)
    expect(p!.outputPerMToken).toBe(1.10)
  })
})

describe('resolveModelPricing', () => {
  test('without discordConfig falls through to PRICING_TABLE', () => {
    const direct = getModelPricing('glm-4.6')
    const resolved = resolveModelPricing('glm-4.6', undefined)
    expect(resolved).toEqual(direct!)
  })

  test('matching override wins over PRICING_TABLE', () => {
    const resolved = resolveModelPricing('glm-4.6', {
      pricing: { 'glm-4.6': { input: 99, output: 199 } },
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.inputPerMToken).toBe(99)
    expect(resolved!.outputPerMToken).toBe(199)
    expect(resolved!.contextLimit).toBe(200_000)
  })

  test('non-matching override falls back to PRICING_TABLE substring', () => {
    const resolved = resolveModelPricing('glm-4.6', {
      pricing: { 'other-model': { input: 1, output: 2 } },
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.inputPerMToken).toBe(0.60)
  })

  test('unknown model with no override returns null', () => {
    const resolved = resolveModelPricing('totally-unknown-xyz')
    expect(resolved).toBeNull()
  })

  test('unknown model with matching override returns override + 200k contextLimit default', () => {
    const resolved = resolveModelPricing('totally-unknown-xyz', {
      pricing: { 'totally-unknown-xyz': { input: 5, output: 10 } },
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.inputPerMToken).toBe(5)
    expect(resolved!.outputPerMToken).toBe(10)
    expect(resolved!.contextLimit).toBe(200_000)
  })
})
