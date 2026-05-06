/**
 * Phase 57 (D-06): Tests for UsageRecord.turnId backward-compat extension.
 *
 * Uses HOME env redirection to a temp dir so JSONL writes don't touch
 * ~/.telemachus in CI or dev. Uses spyOn only (CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendUsage, parseUsageLine, usagePath, type UsageRecord } from './usage-store.js'

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpHome: string
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tmpHome = await mkdtemp(join(tmpdir(), 'kc-usage-test-'))
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseUsageLine turnId backward compat', () => {
  it('accepts a record with turnId', () => {
    const line = '{"ts":"2026-04-17T00:00:00Z","channelId":"c","userId":"u","model":"glm-4.6","inputTokens":10,"outputTokens":20,"turnId":"abc-123"}'
    const r = parseUsageLine(line)
    expect(r).not.toBeNull()
    expect(r!.turnId).toBe('abc-123')
  })

  it('accepts a record without turnId (legacy shape)', () => {
    const line = '{"ts":"2026-04-17T00:00:00Z","channelId":"c","userId":"u","model":"glm-4.6","inputTokens":10,"outputTokens":20}'
    const r = parseUsageLine(line)
    expect(r).not.toBeNull()
    expect(r!.turnId).toBeUndefined()
  })

  it('appendUsage round-trip preserves turnId', async () => {
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      channelId: 'channel-1',
      userId: 'user-1',
      model: 'glm-4.6',
      inputTokens: 100,
      outputTokens: 50,
      turnId: 'turn-uuid-xyz',
    }
    await appendUsage(record)
    const filePath = usagePath()
    const content = await readFile(filePath, 'utf8')
    const parsed = parseUsageLine(content.trim())
    expect(parsed).not.toBeNull()
    expect(parsed!.turnId).toBe('turn-uuid-xyz')
    expect(parsed!.inputTokens).toBe(100)
  })
})
