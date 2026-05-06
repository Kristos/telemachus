/**
 * Phase 36 (UPDATE-06): Tests for buildStartupDm message builder.
 */
import { describe, expect, it } from 'bun:test'
import { buildStartupDm } from '../startup-dm.js'

describe('buildStartupDm', () => {
  it('includes version and commit hash with healthy LLM', () => {
    const result = buildStartupDm({
      version: '1.8.0',
      commitHash: 'abc1234defgh',
      timestamp: '2026-04-13T07:00:00.000Z',
      llmHealth: { ok: true },
    })

    expect(result).toContain('tm v1.8.0')
    expect(result).toContain('abc1234')
    expect(result).not.toContain('defgh')  // only first 7 chars
    expect(result).toContain('2026-04-13T07:00:00.000Z')
    expect(result).toContain('LLM: OK')
  })

  it('includes "LLM: unreachable" when LLM is unhealthy', () => {
    const result = buildStartupDm({
      version: '1.8.0',
      commitHash: 'abc1234',
      timestamp: '2026-04-13T07:00:00.000Z',
      llmHealth: { ok: false, error: 'timeout' },
    })

    expect(result).toContain('LLM: unreachable (timeout)')
    expect(result).not.toContain('LLM: OK')
  })

  it('includes "KC restarted" header', () => {
    const result = buildStartupDm({
      version: '1.8.0',
      commitHash: 'abc1234',
      timestamp: '2026-04-13T07:00:00.000Z',
      llmHealth: { ok: true },
    })

    expect(result).toContain('Telemachus restarted')
  })

  it('truncates commit hash to 7 chars', () => {
    const result = buildStartupDm({
      version: '1.0.0',
      commitHash: '0123456789abcdef',
      timestamp: '2026-01-01T00:00:00.000Z',
      llmHealth: { ok: true },
    })

    expect(result).toContain('0123456')
    expect(result).not.toContain('0123456789')
  })

  it('handles missing error message in unhealthy LLM', () => {
    const result = buildStartupDm({
      version: '1.8.0',
      commitHash: 'abc1234',
      timestamp: '2026-04-13T07:00:00.000Z',
      llmHealth: { ok: false },
    })

    expect(result).toContain('LLM: unreachable')
  })
})
