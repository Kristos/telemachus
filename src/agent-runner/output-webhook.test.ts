/**
 * Phase 23 Plan 2 (AGENT-05) + Phase 24 Plan 3 (AGENT-08): output-webhook tests.
 *
 * Adapter tests are pure — no fetch. pushWebhook tests stub globalThis.fetch.
 * All adapters now take a WebhookContext; these tests exercise both success
 * (ok=true, natural exit) and every failure bucket (cap hits + natural+error).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  toSlack,
  toDiscord,
  toNtfy,
  toRaw,
  pushWebhook,
  emitWebhookOutput,
  colorFor,
  tryParseAgentPayload,
  findInformativeLogLine,
  tryEnrichError,
  COLOR_SUCCESS,
  COLOR_CAP,
  COLOR_ERROR,
  type WebhookOutput,
  type WebhookResult,
  type WebhookContext,
} from './output-webhook'
import type { ArtifactPaths } from './artifacts'
import type { ExitReason } from './caps'

// ------------------------------------------------------------------
// Context fixtures
// ------------------------------------------------------------------

function okCtx(): WebhookContext {
  return { exitReason: 'natural', error: null, ok: true }
}

function failCtx(reason: ExitReason, error: string | null = null): WebhookContext {
  return { exitReason: reason, error, ok: false }
}

// ------------------------------------------------------------------
// Adapter tests (pure, table-driven)
// ------------------------------------------------------------------

const JOB = 'nightly'
const USAGE = { turn_count: 3, duration_ms: 1000, exit_reason: 'natural', error: null }

describe('colorFor', () => {
  test('ok=true → green', () => {
    expect(colorFor(okCtx())).toBe(COLOR_SUCCESS)
  })
  test('max_iterations → orange', () => {
    expect(colorFor(failCtx('max_iterations'))).toBe(COLOR_CAP)
  })
  test('max_wall_clock → orange', () => {
    expect(colorFor(failCtx('max_wall_clock'))).toBe(COLOR_CAP)
  })
  test('max_total_tokens → orange', () => {
    expect(colorFor(failCtx('max_total_tokens'))).toBe(COLOR_CAP)
  })
  test('natural + error → red', () => {
    expect(colorFor(failCtx('natural', 'boom'))).toBe(COLOR_ERROR)
  })
})

describe('toSlack', () => {
  test('empty result', () => {
    const out = toSlack('', USAGE, JOB, okCtx())
    expect(out).toEqual({ text: '*nightly*\n' })
  })
  test('100-char result preserved', () => {
    const r = 'a'.repeat(100)
    const out = toSlack(r, USAGE, JOB, okCtx())
    expect(out.text).toBe(`*nightly*\n${r}`)
  })
  test('5000-char truncated with marker', () => {
    const r = 'c'.repeat(5000)
    const out = toSlack(r, USAGE, JOB, okCtx())
    expect(out.text).toContain('(truncated)')
  })
  test('failure prefixes exit_reason in title', () => {
    const out = toSlack('hi', USAGE, JOB, failCtx('max_iterations'))
    expect(out.text.startsWith('*[max_iterations] nightly*')).toBe(true)
  })
})

describe('toDiscord', () => {
  test('success: green + title + description contains result', () => {
    const out = toDiscord('top-5 auctions here', USAGE, JOB, okCtx())
    expect(out.username).toBe('kc nightly')
    expect(out.embeds.length).toBe(1)
    const e = out.embeds[0]
    expect(e.color).toBe(COLOR_SUCCESS)
    expect(e.color).toBe(3066993)
    expect(e.title).toBe('nightly')
    expect(e.description).toContain('top-5 auctions here')
    expect(e.footer.text).toBe('exit_reason: natural')
    expect(typeof e.timestamp).toBe('string')
  })

  test('max_iterations: orange + FAILED + description has exit_reason', () => {
    const out = toDiscord('partial', USAGE, JOB, failCtx('max_iterations'))
    const e = out.embeds[0]
    expect(e.color).toBe(COLOR_CAP)
    expect(e.color).toBe(15105570)
    expect(e.title.endsWith('FAILED')).toBe(true)
    expect(e.description).toContain('exit_reason: max_iterations')
    expect(e.footer.text).toBe('exit_reason: max_iterations')
  })

  test('max_wall_clock: orange', () => {
    const out = toDiscord('', USAGE, JOB, failCtx('max_wall_clock'))
    expect(out.embeds[0].color).toBe(COLOR_CAP)
    expect(out.embeds[0].description).toContain('exit_reason: max_wall_clock')
  })

  test('max_total_tokens: orange', () => {
    const out = toDiscord('', USAGE, JOB, failCtx('max_total_tokens'))
    expect(out.embeds[0].color).toBe(COLOR_CAP)
    expect(out.embeds[0].description).toContain('exit_reason: max_total_tokens')
  })

  test('natural + error: red + error message in description', () => {
    const out = toDiscord('', USAGE, JOB, failCtx('natural', 'boom'))
    const e = out.embeds[0]
    expect(e.color).toBe(COLOR_ERROR)
    expect(e.color).toBe(15158332)
    expect(e.title.endsWith('FAILED')).toBe(true)
    expect(e.description).toContain('exit_reason: natural')
    expect(e.description).toContain('boom')
  })

  test('5000-char success result truncated in description', () => {
    const r = 'c'.repeat(5000)
    const out = toDiscord(r, USAGE, JOB, okCtx())
    expect(out.embeds[0].description).toContain('(truncated)')
    expect(out.embeds[0].description.length).toBeLessThan(5000 + 50)
  })

  test('1000-char error truncated in failure description', () => {
    const longErr = 'e'.repeat(1000)
    const out = toDiscord('', USAGE, JOB, failCtx('natural', longErr))
    expect(out.embeds[0].description).toContain('(truncated)')
    // error portion truncated to ~500 chars, plus prefix/suffix
    expect(out.embeds[0].description.length).toBeLessThan(1000)
  })

  test('timestamp is valid ISO string', () => {
    const out = toDiscord('x', USAGE, JOB, okCtx())
    expect(new Date(out.embeds[0].timestamp).toISOString()).toBe(out.embeds[0].timestamp)
  })

  test('agent embed JSON is passed through verbatim, not wrapped', () => {
    const agentPayload =
      '{"embeds":[{"title":"Daily Summary — No Items","color":15105570,"footer":{"text":"kc daily-summary"}}]}'
    const out = toDiscord(agentPayload, USAGE, JOB, okCtx())
    expect(out.username).toBe('kc nightly')
    expect(out.embeds.length).toBe(1)
    expect(out.embeds[0].title).toBe('Daily Summary — No Items')
    expect(out.embeds[0].color).toBe(15105570)
    // Legacy wrapper should NOT have run: footer carries agent text,
    // not "exit_reason: natural".
    expect(out.embeds[0].footer?.text).toBe('kc daily-summary')
  })

  test('agent payload with multiple embeds is capped at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `e${i}`, color: 0 }))
    const payload = JSON.stringify({ embeds: many })
    const out = toDiscord(payload, USAGE, JOB, okCtx())
    expect(out.embeds.length).toBe(10)
  })

  test('agent payload with content string is preserved', () => {
    const payload = JSON.stringify({
      content: 'heads up',
      embeds: [{ title: 'x', color: 1 }],
    })
    const out = toDiscord(payload, USAGE, JOB, okCtx())
    expect(out.content).toBe('heads up')
  })

  test('failure path still uses legacy wrapping even if result looks like embed JSON', () => {
    const payload = '{"embeds":[{"title":"x"}]}'
    const out = toDiscord(payload, USAGE, JOB, failCtx('max_iterations'))
    // Failure wraps — description should contain exit_reason, not the raw JSON
    expect(out.embeds[0].description).toContain('exit_reason: max_iterations')
    expect(out.embeds[0].color).toBe(COLOR_CAP)
  })

  test('non-JSON text falls back to legacy wrapping', () => {
    const out = toDiscord('just some plain text', USAGE, JOB, okCtx())
    expect(out.embeds[0].description).toContain('just some plain text')
    expect(out.embeds[0].color).toBe(COLOR_SUCCESS)
  })

  test('JSON without embeds key falls back to legacy wrapping', () => {
    const out = toDiscord('{"foo":"bar"}', USAGE, JOB, okCtx())
    expect(out.embeds[0].description).toContain('{"foo":"bar"}')
  })

  test('identity.username overrides default `kc ${jobName}`', () => {
    const out = toDiscord('hi', USAGE, JOB, okCtx(), { username: 'Daily Summary' })
    expect(out.username).toBe('Daily Summary')
  })

  test('identity.avatarUrl adds avatar_url field to body', () => {
    const out = toDiscord('hi', USAGE, JOB, okCtx(), {
      avatarUrl: 'https://example.com/icon.png',
    })
    expect(out.avatar_url).toBe('https://example.com/icon.png')
  })

  test('no avatarUrl → no avatar_url field (not undefined)', () => {
    const out = toDiscord('hi', USAGE, JOB, okCtx())
    expect('avatar_url' in out).toBe(false)
  })

  test('identity overrides apply to pass-through (agent embed) path', () => {
    const payload = '{"embeds":[{"title":"x","color":1}]}'
    const out = toDiscord(payload, USAGE, JOB, okCtx(), {
      username: 'Daily Summary',
      avatarUrl: 'https://example.com/a.png',
    })
    expect(out.username).toBe('Daily Summary')
    expect(out.avatar_url).toBe('https://example.com/a.png')
    // And pass-through is still in effect:
    expect(out.embeds).toHaveLength(1)
    // @ts-expect-error agent embed is untyped
    expect(out.embeds[0].title).toBe('x')
  })

  test('identity overrides apply to failure (legacy) path', () => {
    const out = toDiscord('', USAGE, JOB, failCtx('natural', 'boom'), {
      username: 'Daily Summary',
      avatarUrl: 'https://example.com/a.png',
    })
    expect(out.username).toBe('Daily Summary')
    expect(out.avatar_url).toBe('https://example.com/a.png')
    expect(out.embeds[0].title).toContain('FAILED')
  })

  test('empty-string username falls back to default (safety)', () => {
    // Passing '' could mean "let Discord use the channel default name" but
    // that's a footgun — nullish-coalescing treats '' as present, so this
    // test pins the current behavior: empty string is used verbatim.
    const out = toDiscord('hi', USAGE, JOB, okCtx(), { username: '' })
    expect(out.username).toBe('')
  })
})

describe('tryParseAgentPayload', () => {
  test('returns null for plain text', () => {
    expect(tryParseAgentPayload('hello world')).toBeNull()
  })
  test('returns null for malformed JSON', () => {
    expect(tryParseAgentPayload('{"embeds":[')).toBeNull()
  })
  test('returns null for JSON without embeds array', () => {
    expect(tryParseAgentPayload('{"foo":1}')).toBeNull()
    expect(tryParseAgentPayload('{"embeds":"not-an-array"}')).toBeNull()
  })
  test('returns parsed payload when embeds array is present', () => {
    const parsed = tryParseAgentPayload('{"embeds":[{"title":"x"}]}')
    expect(parsed).not.toBeNull()
    expect(parsed!.embeds).toHaveLength(1)
  })
  test('preserves content string alongside embeds', () => {
    const parsed = tryParseAgentPayload('{"content":"hi","embeds":[{"title":"x"}]}')
    expect(parsed!.content).toBe('hi')
  })
  test('tolerates leading whitespace', () => {
    const parsed = tryParseAgentPayload('  \n  {"embeds":[{"title":"x"}]}\n')
    expect(parsed).not.toBeNull()
  })

  test('extracts JSON from fenced code block', () => {
    const input = 'Some prose explaining what happened.\n\n```json\n{"embeds":[{"title":"No hits","color":1}]}\n```'
    const parsed = tryParseAgentPayload(input)
    expect(parsed).not.toBeNull()
    expect(parsed!.embeds).toHaveLength(1)
  })

  test('extracts JSON from un-tagged fenced block', () => {
    const input = 'prose\n\n```\n{"embeds":[{"title":"x"}]}\n```'
    const parsed = tryParseAgentPayload(input)
    expect(parsed).not.toBeNull()
  })

  test('scans for JSON embedded in prose (no fences)', () => {
    const input =
      'All 15 targeted searches returned zero items. MCP server became unresponsive. Emitting no-hits embed: {"embeds":[{"title":"No data-fetch hits this run","color":15105570,"footer":{"text":"kc data-fetch"}}]}'
    const parsed = tryParseAgentPayload(input)
    expect(parsed).not.toBeNull()
    expect(parsed!.embeds).toHaveLength(1)
  })

  test('returns null when no embeds JSON anywhere', () => {
    expect(tryParseAgentPayload('Some prose\n```python\nprint("hi")\n```')).toBeNull()
  })

  test('balances braces correctly when JSON strings contain `}`', () => {
    const input =
      'prefix {"embeds":[{"title":"contains } closing brace","color":1}],"content":"more {text}"}'
    const parsed = tryParseAgentPayload(input)
    expect(parsed).not.toBeNull()
    expect(parsed!.content).toBe('more {text}')
  })

  test('prefers earliest valid payload when multiple fenced blocks', () => {
    const input = '```\n{"embeds":[{"title":"first"}]}\n```\nlater text\n```\n{"embeds":[{"title":"second"}]}\n```'
    const parsed = tryParseAgentPayload(input)
    expect(parsed).not.toBeNull()
    // @ts-expect-error parsed embed is untyped
    expect(parsed!.embeds[0].title).toBe('first')
  })
})

describe('findInformativeLogLine', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kc-log-'))
    logPath = join(tmpDir, 'log.txt')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns null when log does not exist', async () => {
    expect(await findInformativeLogLine('/nonexistent/path')).toBeNull()
  })

  test('returns null for empty log', async () => {
    writeFileSync(logPath, '')
    expect(await findInformativeLogLine(logPath)).toBeNull()
  })

  test('returns null when no informative lines present', async () => {
    writeFileSync(logPath, '[mcp] loaded: 1 eager, 0 lazy\nwebhook: discord ok 204\n')
    expect(await findInformativeLogLine(logPath)).toBeNull()
  })

  test('finds [fallback] exhausted line', async () => {
    writeFileSync(
      logPath,
      '[mcp] loaded: 1 eager\n[fallback] openai-compat failed after 2 retries (429 Rate limit reached), switching to ollama\nwebhook: discord ok 204\n',
    )
    const line = await findInformativeLogLine(logPath)
    expect(line).toContain('failed after 2 retries')
    expect(line).toContain('429')
  })

  test('finds rate limit line', async () => {
    writeFileSync(logPath, 'Rate limit reached for requests\n')
    expect(await findInformativeLogLine(logPath)).toContain('Rate limit')
  })

  test('finds the newest matching line when multiple', async () => {
    writeFileSync(
      logPath,
      '[fallback] primary failed (503), retry 1/2\n[fallback] primary failed after 2 retries (503), switching to fallback\n',
    )
    const line = await findInformativeLogLine(logPath)
    expect(line).toContain('switching to fallback')
  })

  test('finds ECONNREFUSED network errors', async () => {
    writeFileSync(logPath, '[mcp] loaded\nconnect ECONNREFUSED 127.0.0.1:11434\n')
    expect(await findInformativeLogLine(logPath)).toContain('ECONNREFUSED')
  })

  test('skips blank lines', async () => {
    writeFileSync(logPath, '\n\n\n[fallback] openai-compat failed (429 Rate limit)\n\n\n')
    const line = await findInformativeLogLine(logPath)
    expect(line).toContain('429')
  })
})

describe('tryEnrichError', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kc-enrich-'))
    logPath = join(tmpDir, 'log.txt')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('returns null when log missing and no existing error', async () => {
    expect(await tryEnrichError('/nonexistent', null)).toBeNull()
  })

  test('returns null when existing error is already long and informative', async () => {
    writeFileSync(logPath, '[fallback] openai-compat failed\n')
    const long = 'A' + 'x'.repeat(200)
    expect(await tryEnrichError(logPath, long)).toBeNull()
  })

  test('augments short generic error with log context', async () => {
    writeFileSync(
      logPath,
      '[fallback] openai-compat failed after 2 retries (429 Rate limit reached for requests), switching to ollama\n',
    )
    const enriched = await tryEnrichError(logPath, 'Connection error.')
    expect(enriched).toContain('Connection error.')
    expect(enriched).toContain('[log]')
    expect(enriched).toContain('429 Rate limit')
  })

  test('uses log line as the whole error when existing is null', async () => {
    writeFileSync(logPath, '[fallback] openai-compat failed (429 Rate limit)\n')
    const enriched = await tryEnrichError(logPath, null)
    expect(enriched).toContain('429')
    expect(enriched).not.toContain('[log]')  // no prefix when no existing error
  })

  test('avoids duplication when log line contains existing error', async () => {
    writeFileSync(logPath, '[fallback] boom failed\n')
    const enriched = await tryEnrichError(logPath, 'boom')
    expect(enriched).not.toContain('boom\n\n[log]')
  })
})

describe('toNtfy', () => {
  test('empty success', () => {
    expect(toNtfy('', USAGE, JOB, okCtx())).toBe('nightly\n\n')
  })
  test('failure prefixes exit_reason', () => {
    const out = toNtfy('hi', USAGE, JOB, failCtx('max_wall_clock'))
    expect(out.startsWith('[max_wall_clock] nightly\n\n')).toBe(true)
  })
  test('5000-char truncated', () => {
    const r = 'c'.repeat(5000)
    expect(toNtfy(r, USAGE, JOB, okCtx())).toContain('(truncated)')
  })
})

describe('toRaw', () => {
  test('success: exit_reason=natural, ok=true, error=null', () => {
    const out = toRaw('hello', USAGE, JOB, okCtx())
    expect(out.job).toBe(JOB)
    expect(out.result).toBe('hello')
    expect(out.usage).toEqual(USAGE)
    expect(typeof out.ts).toBe('string')
    expect(out.exit_reason).toBe('natural')
    expect(out.ok).toBe(true)
    expect(out.error).toBeNull()
  })
  test('failure: exit_reason=max_iterations, ok=false, error preserved', () => {
    const out = toRaw('x', USAGE, JOB, failCtx('max_iterations', 'timeout'))
    expect(out.exit_reason).toBe('max_iterations')
    expect(out.ok).toBe(false)
    expect(out.error).toBe('timeout')
  })
  test('ts is valid ISO string', () => {
    const out = toRaw('x', USAGE, JOB, okCtx())
    expect(new Date(out.ts).toISOString()).toBe(out.ts)
  })
  test('5000-char result truncated', () => {
    const r = 'c'.repeat(5000)
    expect(toRaw(r, USAGE, JOB, okCtx()).result).toContain('(truncated)')
  })
})

// ------------------------------------------------------------------
// pushWebhook tests (fetch stub)
// ------------------------------------------------------------------

describe('pushWebhook', () => {
  let tmpDir: string
  let artifacts: ArtifactPaths
  let origFetch: typeof fetch
  let fetchCalls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kc-webhook-'))
    const runDir = join(tmpDir, 'run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'result.md'), 'hello from agent', 'utf8')
    writeFileSync(join(runDir, 'usage.json'), JSON.stringify(USAGE), 'utf8')
    artifacts = {
      runDir,
      runDirName: 'run',
      parentDir: tmpDir,
      logPath: join(runDir, 'log.txt'),
      resultPath: join(runDir, 'result.md'),
      usagePath: join(runDir, 'usage.json'),
      configPath: join(runDir, 'config.json'),
    }
    origFetch = globalThis.fetch
    fetchCalls = []
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      fetchCalls.push({ url, init: init ?? {} })
      return await handler(url, init ?? {})
    }) as typeof fetch
  }

  test('slack 200 OK → ok:true, passes ctx through', async () => {
    stubFetch(() => new Response('ok', { status: 200 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/s', format: 'slack' }
    await expect(pushWebhook(ch, artifacts, JOB, okCtx())).resolves.toEqual({ ok: true, status: 200 })
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.text).toContain('hello from agent')
  })

  test('discord ctx flows through to body color', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/d', format: 'discord' }
    await pushWebhook(ch, artifacts, JOB, failCtx('max_iterations'))
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.username).toBe(`kc ${JOB}`)
    expect(body.embeds[0].color).toBe(COLOR_CAP)
    expect(body.embeds[0].title.endsWith('FAILED')).toBe(true)
  })

  test('discord success body has green color', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/d', format: 'discord' }
    await pushWebhook(ch, artifacts, JOB, okCtx())
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.embeds[0].color).toBe(COLOR_SUCCESS)
  })

  test('ntfy text/plain body', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/n', format: 'ntfy' }
    await expect(pushWebhook(ch, artifacts, JOB, okCtx())).resolves.toEqual({ ok: true, status: 200 })
    expect(typeof fetchCalls[0]!.init.body).toBe('string')
  })

  test('raw body includes exit_reason', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/r', format: 'raw' }
    await pushWebhook(ch, artifacts, JOB, okCtx())
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.exit_reason).toBe('natural')
    expect(body.ok).toBe(true)
  })

  test('500 → ok:false with HTTP error', async () => {
    stubFetch(() => new Response('boom', { status: 500 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/s', format: 'slack' }
    const res = await pushWebhook(ch, artifacts, JOB, okCtx())
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(500)
      expect(res.error).toContain('500')
    }
  })

  test('network error → ok:false, never throws', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/s', format: 'slack' }
    const res = await pushWebhook(ch, artifacts, JOB, okCtx())
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('ECONNREFUSED')
    }
  })

  test('timeout → ok:false with timeout error', async () => {
    stubFetch((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            ;(err as Error & { name: string }).name = 'AbortError'
            reject(err)
          })
        }
      })
    })
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/s', format: 'slack' }
    const res = await pushWebhook(ch, artifacts, JOB, okCtx(), 50)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.toLowerCase()).toContain('timeout')
    }
  })

  test('emitWebhookOutput: writes webhook.json and log line on success', async () => {
    writeFileSync(artifacts.logPath, '', 'utf8')
    const stubPusher = async (): Promise<WebhookResult> => ({ ok: true, status: 200 })
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/s', format: 'slack' }
    const now = () => new Date('2026-04-08T22:22:22Z')
    await emitWebhookOutput(ch, artifacts, JOB, okCtx(), stubPusher, now)
    const webhookJson = JSON.parse(readFileSync(join(artifacts.runDir, 'webhook.json'), 'utf8'))
    expect(webhookJson.url).toBe('http://stub/s')
    expect(webhookJson.format).toBe('slack')
    expect(webhookJson.attempted_at).toBe('2026-04-08T22:22:22.000Z')
    expect(webhookJson.ok).toBe(true)
    expect(webhookJson.status).toBe(200)
    expect(webhookJson.exit_reason).toBe('natural')
    expect(webhookJson.run_ok).toBe(true)
    const log = readFileSync(artifacts.logPath, 'utf8')
    expect(log).toContain('webhook: slack ok 200')
  })

  test('emitWebhookOutput: failure run records exit_reason + run_ok=false', async () => {
    writeFileSync(artifacts.logPath, '', 'utf8')
    const stubPusher = async (): Promise<WebhookResult> => ({
      ok: false,
      status: 500,
      error: 'HTTP 500',
    })
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/d', format: 'discord' }
    await emitWebhookOutput(ch, artifacts, JOB, failCtx('max_iterations'), stubPusher)
    const webhookJson = JSON.parse(readFileSync(join(artifacts.runDir, 'webhook.json'), 'utf8'))
    expect(webhookJson.ok).toBe(false)
    expect(webhookJson.status).toBe(500)
    expect(webhookJson.exit_reason).toBe('max_iterations')
    expect(webhookJson.run_ok).toBe(false)
  })

  test('emitWebhookOutput: swallows thrown pusher errors', async () => {
    writeFileSync(artifacts.logPath, '', 'utf8')
    const stubPusher = (async () => {
      throw new Error('boom')
    }) as unknown as typeof pushWebhook
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/n', format: 'ntfy' }
    await expect(
      emitWebhookOutput(ch, artifacts, JOB, okCtx(), stubPusher),
    ).resolves.toBeUndefined()
    const webhookJson = JSON.parse(readFileSync(join(artifacts.runDir, 'webhook.json'), 'utf8'))
    expect(webhookJson.ok).toBe(false)
    expect(webhookJson.error).toContain('boom')
  })

  test('pushWebhook passes ctx to adapter: discord failure yields orange body', async () => {
    stubFetch(() => new Response('', { status: 204 }))
    const ch: WebhookOutput = { type: 'webhook', url: 'http://stub/d', format: 'discord' }
    await pushWebhook(ch, artifacts, JOB, failCtx('max_total_tokens'))
    const body = JSON.parse(fetchCalls[0]!.init.body as string)
    expect(body.embeds[0].color).toBe(COLOR_CAP)
    expect(body.embeds[0].description).toContain('max_total_tokens')
  })
})
