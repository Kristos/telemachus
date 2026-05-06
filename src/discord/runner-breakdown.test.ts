/**
 * Phase 59 (D-12): Unit tests for finalizeTurnSummary layerBreakdown population.
 *
 * Tests the pure helper exported from runner.ts — no Discord coupling,
 * no mock.module() required. Verifies the three critical behaviors:
 *   1. Populated routerSession fields → layerBreakdown present
 *   2. Undefined routerSession fields → layerBreakdown has only defined keys
 *   3. Empty routerSession → layerBreakdown absent entirely
 *
 * Phase 74: routedTo values updated from 'simple'/'complex' to IntentClass values.
 */
import { describe, it, expect } from 'bun:test'
import { finalizeTurnSummary } from './runner.js'

const baseMeta = { channelId: 'ch-123', userId: 'u-456', model: 'glm-4.6' }
const baseAgg = { inputTokens: 100, outputTokens: 50, costUsd: 0.02 }

describe('finalizeTurnSummary layerBreakdown population (D-12)', () => {
  it('writes layerBreakdown when RouterProvider sets routedTo and classifierTokens', () => {
    const routerSession = { routedTo: 'casual' as const, classifierTokens: 42 }
    const record = finalizeTurnSummary('turn-001', baseAgg, routerSession, baseMeta)

    expect(record.layerBreakdown).toBeDefined()
    expect(record.layerBreakdown?.routedTo).toBe('casual')
    expect(record.layerBreakdown?.classifierTokens).toBe(42)
  })

  it('writes layerBreakdown when only routedTo is set (classifierTokens absent)', () => {
    const routerSession = { routedTo: 'orchestration' as const }
    const record = finalizeTurnSummary('turn-002', baseAgg, routerSession, baseMeta)

    expect(record.layerBreakdown).toBeDefined()
    expect(record.layerBreakdown?.routedTo).toBe('orchestration')
    // classifierTokens should not be present (no undefined key emitted)
    expect('classifierTokens' in (record.layerBreakdown ?? {})).toBe(false)
  })

  it('omits layerBreakdown when routerSession has no populated fields (no-router path)', () => {
    const routerSession = {}  // empty — router not active
    const record = finalizeTurnSummary('turn-003', baseAgg, routerSession, baseMeta)

    // No layerBreakdown key at all
    expect('layerBreakdown' in record).toBe(false)
  })

  it('populates base fields correctly regardless of router state', () => {
    const routerSession = {}
    const record = finalizeTurnSummary('turn-004', baseAgg, routerSession, baseMeta)

    expect(record.turnId).toBe('turn-004')
    expect(record.channelId).toBe('ch-123')
    expect(record.userId).toBe('u-456')
    expect(record.model).toBe('glm-4.6')
    expect(record.totalInputTokens).toBe(100)
    expect(record.totalOutputTokens).toBe(50)
    expect(record.totalCostUsd).toBe(0.02)
    expect(record.ts).toBeTruthy()
  })

  it('layerBreakdown does not include undefined-valued keys (D-12 invariant)', () => {
    // routerSession has both fields undefined-ish — only routedTo set
    const routerSession = { routedTo: 'casual' as const, classifierTokens: undefined }
    const record = finalizeTurnSummary('turn-005', baseAgg, routerSession, baseMeta)

    // Only routedTo should appear — classifierTokens was undefined
    expect(record.layerBreakdown?.routedTo).toBe('casual')
    expect('classifierTokens' in (record.layerBreakdown ?? {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// COST-02 + COST-08 (Phase 61): contextSizeTokens + routedModel flow
// ---------------------------------------------------------------------------
//
// COST-02: Phase 59.1 already wired routerSession.routedModel into meta.model
// via the runner.ts finally-block. These tests prove the pure helper honours
// whatever model meta is supplied — the end-to-end wiring test lives in
// turn-summary-store.test.ts round-trip test below.
//
// COST-08: contextSizeTokens flows through the new optional meta field and
// appears on the TurnSummaryRecord iff supplied.
// ---------------------------------------------------------------------------

describe('finalizeTurnSummary COST-02 + COST-08 (Phase 61)', () => {
  it('COST-08: passing contextSizeTokens=150000 writes the field on the record', () => {
    const record = finalizeTurnSummary('turn-cost08-1', baseAgg, {}, {
      ...baseMeta,
      contextSizeTokens: 150_000,
    })
    expect(record.contextSizeTokens).toBe(150_000)
  })

  it('COST-08: omitting contextSizeTokens from meta produces a record without the field', () => {
    const record = finalizeTurnSummary('turn-cost08-2', baseAgg, {}, baseMeta)
    expect('contextSizeTokens' in record).toBe(false)
  })

  it('COST-02: meta.model="glm-4.7-flash" (from routedModel) produces summary.model="glm-4.7-flash"', () => {
    const record = finalizeTurnSummary('turn-cost02-1', baseAgg, { routedTo: 'casual' }, {
      channelId: 'ch',
      userId: 'u',
      model: 'glm-4.7-flash',
    })
    expect(record.model).toBe('glm-4.7-flash')
  })

  it('COST-02: meta.model="glm-4.6" produces summary.model="glm-4.6"', () => {
    const record = finalizeTurnSummary('turn-cost02-2', baseAgg, { routedTo: 'orchestration' }, {
      channelId: 'ch',
      userId: 'u',
      model: 'glm-4.6',
    })
    expect(record.model).toBe('glm-4.6')
  })

  it('layerBreakdown coexists with contextSizeTokens (both fields present)', () => {
    const record = finalizeTurnSummary(
      'turn-both',
      baseAgg,
      { routedTo: 'casual', classifierTokens: 12 },
      { ...baseMeta, contextSizeTokens: 64_000 },
    )
    expect(record.contextSizeTokens).toBe(64_000)
    expect(record.layerBreakdown?.routedTo).toBe('casual')
    expect(record.layerBreakdown?.classifierTokens).toBe(12)
  })

  it('zero-agg record with no contextSizeTokens + empty routerSession has minimal shape', () => {
    const zeroAgg = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const record = finalizeTurnSummary('turn-minimal', zeroAgg, {}, baseMeta)
    expect('contextSizeTokens' in record).toBe(false)
    expect('layerBreakdown' in record).toBe(false)
    expect(record.totalInputTokens).toBe(0)
    expect(record.totalOutputTokens).toBe(0)
    expect(record.totalCostUsd).toBe(0)
  })
})
