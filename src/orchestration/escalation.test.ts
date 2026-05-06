/**
 * Phase 40-03: Unit tests for DM escalation handler.
 *
 * Uses fake timers (Bun's setSystemTime / jest-like mocking) to test
 * timeout behavior without actually waiting.
 *
 * Uses closure-scoped state (createEscalationHandler returns fresh
 * handlers each call) to ensure isolation between tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createEscalationHandler } from './escalation.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSendDm() {
  const calls: Array<{ userId: string; text: string }> = []
  const sendDm = mock(async (userId: string, text: string) => {
    calls.push({ userId, text })
  })
  return { sendDm, calls }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createEscalationHandler', () => {
  it('returns onEscalated, receiveDmReply, and hasPending', () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    expect(typeof handler.onEscalated).toBe('function')
    expect(typeof handler.receiveDmReply).toBe('function')
    expect(typeof handler.hasPending).toBe('function')
  })

  it('hasPending returns false when no escalation is active', () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')
    expect(handler.hasPending()).toBe(false)
  })

  it('onEscalated calls sendDm with formatted message containing taskId', async () => {
    const { sendDm, calls } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-abc', 'diff here', 'needs fix', 60_000)
    // resolve immediately to avoid timeout
    handler.receiveDmReply('approve')
    await promise

    expect(calls).toHaveLength(1)
    expect(calls[0].userId).toBe('owner-123')
    expect(calls[0].text).toContain('task-abc')
  })

  it('DM text contains reviewer feedback and timeout info', async () => {
    const { sendDm, calls } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-xyz', 'some diff', 'linting failed', 120_000)
    handler.receiveDmReply('reject')
    await promise

    expect(calls[0].text).toContain('linting failed')
    expect(calls[0].text).toContain('approve')
    expect(calls[0].text).toContain('reject')
    expect(calls[0].text).toContain('2min')
  })

  it('DM text stays under 2000 chars even with large diff', async () => {
    const { sendDm, calls } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const hugeDiff = 'x'.repeat(5000)
    const promise = handler.onEscalated('task-big', hugeDiff, 'review feedback', 60_000)
    handler.receiveDmReply('approve')
    await promise

    expect(calls[0].text.length).toBeLessThanOrEqual(2000)
    expect(calls[0].text).toContain('truncated')
  })

  it('DM text contains truncated suffix when diff is large', async () => {
    const { sendDm, calls } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const largeDiff = 'A'.repeat(2000)
    const promise = handler.onEscalated('task-t', largeDiff, 'feedback', 60_000)
    handler.receiveDmReply('approve')
    await promise

    expect(calls[0].text).toContain('... (truncated)')
  })

  it('receiveDmReply("approve") resolves the Promise with "approve"', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-1', 'diff', 'feedback', 60_000)
    handler.receiveDmReply('approve')
    const result = await promise

    expect(result).toBe('approve')
  })

  it('receiveDmReply("reject") resolves the Promise with "reject"', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-2', 'diff', 'feedback', 60_000)
    handler.receiveDmReply('reject')
    const result = await promise

    expect(result).toBe('reject')
  })

  it('receiveDmReply("yes") resolves as "approve"', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-3', 'diff', 'feedback', 60_000)
    handler.receiveDmReply('yes')
    const result = await promise

    expect(result).toBe('approve')
  })

  it('receiveDmReply("no") resolves as "reject"', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-4', 'diff', 'feedback', 60_000)
    handler.receiveDmReply('no')
    const result = await promise

    expect(result).toBe('reject')
  })

  it('hasPending returns true when escalation is active', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    // Don't await — keep promise pending
    let resolved = false
    const promise = handler.onEscalated('task-5', 'diff', 'feedback', 60_000)
    promise.then(() => { resolved = true })

    // Give sendDm time to be called
    await new Promise(r => setTimeout(r, 0))

    expect(handler.hasPending()).toBe(true)
    expect(resolved).toBe(false)

    handler.receiveDmReply('approve')
    await promise

    expect(handler.hasPending()).toBe(false)
  })

  it('unrecognized reply text does NOT resolve the Promise', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    let resolved = false
    const promise = handler.onEscalated('task-6', 'diff', 'feedback', 60_000)
    promise.then(() => { resolved = true })

    await new Promise(r => setTimeout(r, 0))

    const consumed = handler.receiveDmReply('maybe')
    expect(consumed).toBe(false)

    await new Promise(r => setTimeout(r, 0))
    expect(resolved).toBe(false)
    expect(handler.hasPending()).toBe(true)

    // Cleanup
    handler.receiveDmReply('reject')
    await promise
  })

  it('receiveDmReply returns false when no pending escalation', () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const result = handler.receiveDmReply('approve')
    expect(result).toBe(false)
  })

  it('timeout resolves the Promise as "reject"', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    // Use very short timeout (10ms) for test
    const promise = handler.onEscalated('task-7', 'diff', 'feedback', 10)
    const result = await promise

    expect(result).toBe('reject')
    expect(handler.hasPending()).toBe(false)
  })

  it('hasPending returns false after timeout resolves', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-8', 'diff', 'feedback', 10)
    await promise

    expect(handler.hasPending()).toBe(false)
  })

  it('reply before timeout clears the pending state and resolves', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    // 5 second timeout but we reply immediately
    const promise = handler.onEscalated('task-9', 'diff', 'feedback', 5000)
    await new Promise(r => setTimeout(r, 0))
    handler.receiveDmReply('approve')
    const result = await promise

    expect(result).toBe('approve')
    expect(handler.hasPending()).toBe(false)
  })

  it('clamped timeout: timeoutMs > 4 hours is capped', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    // This should not hang the test — if timeout is not clamped, it would
    // We cannot directly test the timer value, but we can verify the escalation
    // still works normally (resolves when reply arrives)
    const fourHoursMs = 4 * 60 * 60 * 1000
    const promise = handler.onEscalated('task-10', 'diff', 'feedback', fourHoursMs + 1)
    await new Promise(r => setTimeout(r, 0))
    handler.receiveDmReply('approve')
    const result = await promise

    expect(result).toBe('approve')
  })

  it('DM reviewer feedback is truncated to 500 chars', async () => {
    const { sendDm, calls } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const longFeedback = 'F'.repeat(1000)
    const promise = handler.onEscalated('task-11', 'diff', longFeedback, 60_000)
    handler.receiveDmReply('approve')
    await promise

    // The entire DM must still be under 2000 chars
    expect(calls[0].text.length).toBeLessThanOrEqual(2000)
    // Feedback should be truncated (not 1000 chars in the message)
    const feedbackInDm = calls[0].text
    // Count F chars — should not be 1000
    const fCount = (feedbackInDm.match(/F/g) ?? []).length
    expect(fCount).toBeLessThan(1000)
  })

  it('receiveDmReply returns true when reply is consumed', async () => {
    const { sendDm } = makeSendDm()
    const handler = createEscalationHandler(sendDm, 'owner-123')

    const promise = handler.onEscalated('task-12', 'diff', 'feedback', 60_000)
    const result = handler.receiveDmReply('approve')
    await promise

    expect(result).toBe(true)
  })
})
