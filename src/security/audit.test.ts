import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashArgs, appendAuditEntry, auditPath, auditDir, parseAuditLine } from './audit.js'
import type { AuditEntry } from './audit.js'

describe('hashArgs', () => {
  test('returns sha256:<64 hex>', () => {
    const h = hashArgs({ command: 'ls' })
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
  test('is deterministic', () => {
    expect(hashArgs({ command: 'ls' })).toBe(hashArgs({ command: 'ls' }))
  })
  test('differs for different inputs', () => {
    expect(hashArgs({ command: 'ls' })).not.toBe(hashArgs({ command: 'pwd' }))
  })
})

describe('auditPath', () => {
  test('uses YYYY-MM-DD UTC date', () => {
    const fixed = new Date('2026-04-08T23:30:00Z')
    expect(auditPath(fixed)).toMatch(/2026-04-08\.jsonl$/)
  })
  test('is under ~/.telemachus/audit', () => {
    expect(auditPath()).toContain('.telemachus')
    expect(auditPath()).toContain('audit')
  })
})

describe('appendAuditEntry', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'kc-audit-test-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  function sampleEntry(): AuditEntry {
    return {
      ts: new Date().toISOString(),
      kind: 'tool_call',
      sessionId: 'sess-test',
      platform: process.platform,
      tool: 'bash',
      tier: 'dangerous',
      argsHash: hashArgs({ command: 'ls' }),
      resultSize: 42,
      durationMs: 7,
      mode: 'ask',
      exitCode: 0,
      sandbox: 'enforced',
    }
  }

  test('writes one JSONL line', async () => {
    const entry = sampleEntry()
    await appendAuditEntry(entry)
    const path = auditPath()
    expect(existsSync(path)).toBe(true)
    const contents = readFileSync(path, 'utf8')
    expect(contents.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(contents.trim())
    expect(parsed.tool).toBe('bash')
    expect(parsed.tier).toBe('dangerous')
    expect(parsed.sandbox).toBe('enforced')
  })

  test('two appends produce two lines', async () => {
    await appendAuditEntry(sampleEntry())
    await appendAuditEntry(sampleEntry())
    const contents = readFileSync(auditPath(), 'utf8')
    const lines = contents.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
    expect(() => JSON.parse(lines[1]!)).not.toThrow()
  })

  test('does not throw when HOME is unwritable', async () => {
    // Point HOME at a path we cannot create under
    process.env.HOME = '/dev/null/definitely-not-a-dir'
    const entry = sampleEntry()
    // Must not throw — best-effort contract
    await expect(appendAuditEntry(entry)).resolves.toBeUndefined()
  })
})

describe('parseAuditLine', () => {
  // D-14: backward compat — rows written before kind was introduced
  test('v1.3-era row without kind field defaults to tool_call', () => {
    const line = JSON.stringify({
      ts: '2026-01-01T00:00:00Z',
      sessionId: 'abc',
      tool: 'bash',
      tier: 'safe',
      argsHash: 'sha256:aabbcc',
      resultSize: 10,
      durationMs: 5,
      mode: 'ask',
      exitCode: 0,
      platform: 'linux',
      sandbox: 'enforced',
    })
    const entry = parseAuditLine(line)
    expect(entry.kind).toBe('tool_call')
    expect(entry.tool).toBe('bash')
  })

  test('row with explicit kind preserves that kind', () => {
    const line = JSON.stringify({
      ts: '2026-01-01T00:00:00Z',
      kind: 'mcp_sandbox_warning',
      sessionId: 'abc',
      platform: 'linux',
      server: 'foo',
    })
    const entry = parseAuditLine(line)
    expect(entry.kind).toBe('mcp_sandbox_warning')
    expect(entry.server).toBe('foo')
  })

  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'kc-audit-parse-test-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  test('round-trip tool_call row preserves kind', async () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'tool_call',
      sessionId: 'round-trip-test',
      platform: process.platform,
      tool: 'bash',
      tier: 'safe',
      argsHash: hashArgs({ command: 'echo hi' }),
      resultSize: 7,
      durationMs: 3,
      mode: 'ask',
      exitCode: 0,
      sandbox: 'n/a',
    }
    await appendAuditEntry(entry)
    const { readFileSync } = await import('node:fs')
    const contents = readFileSync(auditPath(), 'utf8')
    const parsed = parseAuditLine(contents.trim())
    expect(parsed.kind).toBe('tool_call')
    expect(parsed.tool).toBe('bash')
  })

  test('round-trip mcp_sandbox_warning row preserves server and platform', async () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_sandbox_warning',
      sessionId: 'round-trip-warning-test',
      platform: 'darwin',
      server: 'my-server',
      reason: 'sandbox unavailable',
    }
    await appendAuditEntry(entry)
    const { readFileSync } = await import('node:fs')
    const contents = readFileSync(auditPath(), 'utf8')
    const parsed = parseAuditLine(contents.trim())
    expect(parsed.kind).toBe('mcp_sandbox_warning')
    expect(parsed.server).toBe('my-server')
    expect(parsed.platform).toBe('darwin')
  })
})

// Phase 31 SEC-13: Discord source attribution fields
describe('AuditEntry Discord source attribution (SEC-13)', () => {
  test('AuditEntry with discord source fields serializes correctly', () => {
    const entry: AuditEntry = {
      ts: '2026-04-12T00:00:00.000Z',
      kind: 'tool_call',
      sessionId: 'test-discord',
      platform: 'darwin',
      tool: 'bash',
      source: 'discord',
      discordUserId: '123456789',
      discordChannelId: '987654321',
    }
    const json = JSON.stringify(entry)
    const parsed = JSON.parse(json) as AuditEntry
    expect(parsed.source).toBe('discord')
    expect(parsed.discordUserId).toBe('123456789')
    expect(parsed.discordChannelId).toBe('987654321')
  })

  test('AuditEntry without source fields omits them from JSON', () => {
    const entry: AuditEntry = {
      ts: '2026-04-12T00:00:00.000Z',
      kind: 'tool_call',
      sessionId: 'test-cli',
      platform: 'darwin',
      tool: 'bash',
    }
    const json = JSON.stringify(entry)
    expect(json).not.toContain('source')
    expect(json).not.toContain('discordUserId')
  })
})

// Phase 60 (DISPATCH-09, DISPATCH-04): auto-dispatch audit kinds + payload
describe('Phase 60 auto-dispatch audit kinds', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'kc-audit-dispatch-test-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  test('AuditKind union accepts auto_dispatched (compile-time check)', () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'auto_dispatched',
      sessionId: 'sess-dispatch',
      platform: process.platform,
    }
    expect(entry.kind).toBe('auto_dispatched')
  })

  test('AuditKind union accepts auto_dispatch_refused (compile-time check)', () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'auto_dispatch_refused',
      sessionId: 'sess-dispatch-refused',
      platform: process.platform,
    }
    expect(entry.kind).toBe('auto_dispatch_refused')
  })

  test('round-trip auto_dispatched preserves contentSnippet + signalsMatched', async () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'auto_dispatched',
      sessionId: 'sess-rt-dispatched',
      platform: process.platform,
      turnId: 'turn-abc',
      channelId: 'chan-xyz',
      userId: 'user-123',
      contentSnippet: 'build a login system with auth',
      signalsMatched: ['build-a', 'complexity-files-gt-2'],
    }
    await appendAuditEntry(entry)
    const contents = readFileSync(auditPath(), 'utf8')
    const lines = contents.trim().split('\n').filter(Boolean)
    const parsed = parseAuditLine(lines[lines.length - 1]!)
    expect(parsed.kind).toBe('auto_dispatched')
    expect(parsed.contentSnippet).toBe('build a login system with auth')
    expect(parsed.signalsMatched).toEqual(['build-a', 'complexity-files-gt-2'])
    expect(parsed.turnId).toBe('turn-abc')
    expect(parsed.channelId).toBe('chan-xyz')
  })

  test('round-trip auto_dispatch_refused preserves dispatchReason', async () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'auto_dispatch_refused',
      sessionId: 'sess-rt-refused',
      platform: process.platform,
      turnId: 'turn-def',
      channelId: 'chan-xyz',
      userId: 'user-123',
      contentSnippet: 'set up a new project',
      signalsMatched: ['set-up'],
      dispatchReason: 'budget_exceeded',
    }
    await appendAuditEntry(entry)
    const contents = readFileSync(auditPath(), 'utf8')
    const lines = contents.trim().split('\n').filter(Boolean)
    const parsed = parseAuditLine(lines[lines.length - 1]!)
    expect(parsed.kind).toBe('auto_dispatch_refused')
    expect(parsed.dispatchReason).toBe('budget_exceeded')
    expect(parsed.contentSnippet).toBe('set up a new project')
    expect(parsed.signalsMatched).toEqual(['set-up'])
  })

  test('AuditEntry without Phase 60 optional fields still validates (backward-compat)', () => {
    // Phase 57/59 shape — no contentSnippet, signalsMatched, dispatchReason.
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'router_decision',
      sessionId: 'sess-legacy',
      platform: process.platform,
      turnId: 'turn-legacy',
      decision: 'simple',
    }
    expect(entry.contentSnippet).toBeUndefined()
    expect(entry.signalsMatched).toBeUndefined()
    expect(entry.dispatchReason).toBeUndefined()
    expect(entry.kind).toBe('router_decision')
  })
})

// Phase 26 D-17: narrow type fields on AuditEntry
describe('AuditEntry Phase 26 field additions (D-17)', () => {
  test('pid field accepts null (lifecycle rows have no pid yet)', () => {
    const entry: AuditEntry = {
      ts: '2026-01-01T00:00:00Z',
      kind: 'mcp_spawn',
      sessionId: 'sess-pid-null',
      platform: 'linux',
      server: 'my-srv',
      pid: null,
    }
    expect(entry.pid).toBeNull()
  })

  test('pid field accepts a positive integer', () => {
    const entry: AuditEntry = {
      ts: '2026-01-01T00:00:00Z',
      kind: 'mcp_spawn',
      sessionId: 'sess-pid-int',
      platform: 'linux',
      server: 'my-srv',
      pid: 12345,
    }
    expect(entry.pid).toBe(12345)
  })

  test('was_alive field accepted on mcp_disable rows', () => {
    const entry: AuditEntry = {
      ts: '2026-01-01T00:00:00Z',
      kind: 'mcp_disable',
      sessionId: 'sess-disable',
      platform: 'linux',
      server: 'my-srv',
      was_alive: true,
      pid: null,
    }
    expect(entry.was_alive).toBe(true)
  })

  test('round-trip mcp_spawn row preserves pid: null', async () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      kind: 'mcp_spawn',
      sessionId: 'sess-rt-pid',
      platform: 'linux',
      server: 'my-srv',
      pid: null,
    }
    await appendAuditEntry(entry)
    const { readFileSync } = await import('node:fs')
    const contents = readFileSync(auditPath(), 'utf8')
    const lines = contents.trim().split('\n').filter(Boolean)
    const parsed = parseAuditLine(lines[lines.length - 1]!)
    expect(parsed.kind).toBe('mcp_spawn')
    expect(parsed.pid).toBeNull()
  })
})
