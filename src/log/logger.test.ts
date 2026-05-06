import { describe, it, expect, beforeEach, afterEach, spyOn, test } from 'bun:test'
import { log } from './logger.js'

describe('log()', () => {
  let stderrSpy: ReturnType<typeof spyOn>
  let origKcLogLevel: string | undefined

  beforeEach(() => {
    origKcLogLevel = process.env.KC_LOG_LEVEL
    // Default: info threshold
    delete process.env.KC_LOG_LEVEL
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    if (origKcLogLevel === undefined) {
      delete process.env.KC_LOG_LEVEL
    } else {
      process.env.KC_LOG_LEVEL = origKcLogLevel
    }
  })

  it('emits a JSON line to stderr', () => {
    log('info', { sessionId: 's1' }, 'hello')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const raw = stderrSpy.mock.calls[0]![0] as string
    expect(typeof raw).toBe('string')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['level']).toBe('info')
    expect(parsed['msg']).toBe('hello')
    expect(parsed['sessionId']).toBe('s1')
    expect(typeof parsed['ts']).toBe('string')
  })

  it('ts is a valid ISO 8601 string', () => {
    log('info', {}, 'ts-check')
    const raw = stderrSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const ts = parsed['ts'] as string
    expect(new Date(ts).toISOString()).toBe(ts)
  })

  it('fields spread after base so caller can override msg', () => {
    log('info', { msg: 'override' }, 'original')
    const raw = stderrSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // fields spread AFTER base, so {msg: 'override'} wins
    expect(parsed['msg']).toBe('override')
  })

  it('level filter respects KC_LOG_LEVEL', () => {
    process.env.KC_LOG_LEVEL = 'warn'
    log('info', {}, 'should be suppressed')
    expect(stderrSpy).not.toHaveBeenCalled()
    log('warn', {}, 'should emit')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('unknown KC_LOG_LEVEL falls back to info', () => {
    process.env.KC_LOG_LEVEL = 'garbage'
    log('debug', {}, 'debug should be suppressed')
    expect(stderrSpy).not.toHaveBeenCalled()
    log('info', {}, 'info should emit')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('circular reference does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o: any = {}
    o.self = o
    expect(() => log('error', { data: o }, 'circular')).not.toThrow()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const raw = stderrSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['msg']).toBe('logger_serialize_failed')
    expect(parsed['level']).toBe('error')
  })

  it('correlation fields (sessionId, runId, turnIndex) flow through unchanged', () => {
    log('info', { sessionId: 's1', runId: 'r1', turnIndex: 3 }, 'turn')
    const raw = stderrSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['sessionId']).toBe('s1')
    expect(parsed['runId']).toBe('r1')
    expect(parsed['turnIndex']).toBe(3)
  })
})

test('at least 10 sites migrated — grep sentinel', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  // Base path relative to the project root — go up two directories from src/log
  const base = join(import.meta.dir, '..', '..')

  const migratedFiles = [
    'src/discord/runner.ts',
    'src/discord/usage-store.ts',
    'src/discord/session-bridge.ts',
    'src/discord/daily-dm.ts',
    'src/discord/bot.ts',
    'src/discord/commands.ts',
    'src/orchestration/event-log.ts',
    'src/orchestration/escalation.ts',
    'src/orchestration/queue.ts',
  ]

  let logCalls = 0
  for (const relPath of migratedFiles) {
    const content = await readFile(join(base, relPath), 'utf8')
    const matches = content.match(/\blog\s*\(\s*['"](debug|info|warn|error)['"]/g) ?? []
    logCalls += matches.length
  }
  expect(logCalls).toBeGreaterThanOrEqual(10)
})
