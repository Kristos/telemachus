/**
 * Phase 23 Plan 2 (AGENT-05) + Phase 24 Plan 3 (AGENT-08):
 * output webhook channel with exit-reason context threading.
 *
 * Pure format adapters + a best-effort POST pusher. pushWebhook never throws —
 * all failures are folded into a WebhookResult. The run-job orchestrator calls
 * pushWebhook after artifacts are written, writes webhook.json + a log line,
 * and proceeds to exit regardless of outcome.
 *
 * Phase 24 extension: a WebhookContext is threaded through every adapter so
 * Discord embeds can branch on exitReason (green success / orange cap hit /
 * red error) and non-Discord formats can prefix failure payloads with the
 * exit reason. The context uses the canonical `ExitReason` type from
 * ./caps.js — do NOT re-declare it locally.
 */
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import type { ArtifactPaths } from './artifacts.js'
import type { ExitReason } from './caps.js'

export type WebhookFormat = 'slack' | 'discord' | 'ntfy' | 'raw'

export interface WebhookOutput {
  type: 'webhook'
  url: string
  format: WebhookFormat
  /**
   * Discord-only: override the `username` field on the POST body. Defaults
   * to `kc ${jobName}` when absent. Lets each job present as its own app
   * (e.g. "Daily Summary", "My Agent") instead of everything posting as
   * "tm daily-summary" / "tm my-agent".
   *
   * Non-Discord formats ignore this field.
   */
  username?: string
  /**
   * Discord-only: set the `avatar_url` field on the POST body. When absent,
   * Discord renders the webhook's default avatar (usually the Discord logo).
   * URL must be publicly reachable — Discord refetches it server-side.
   *
   * Non-Discord formats ignore this field.
   */
  avatarUrl?: string
}

export type WebhookResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string }

/**
 * Context threaded from run-job.ts into every webhook adapter.
 *
 * `exitReason` is the canonical ExitReason from caps.ts — errors are tracked
 * SEPARATELY via the `error` field. A natural exit with a non-null error is
 * still a failure (ok=false, red embed).
 */
export interface WebhookContext {
  exitReason: ExitReason
  error: string | null
  ok: boolean
}

// Discord embed colors (decimal form of hex).
export const COLOR_SUCCESS = 3066993 // 0x2ECC71 green
export const COLOR_CAP = 15105570 // 0xE67E22 orange
export const COLOR_ERROR = 15158332 // 0xE74C3C red

const SHORT_MAX = 1500 // slack, ntfy prefix
const LONG_MAX = 4000 // ntfy, raw, discord description

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…(truncated)'
}

/**
 * Branching rule for Discord embed color:
 *   ok=true                                            → green
 *   exitReason ∈ {max_iterations, max_wall_clock,
 *                 max_total_tokens}                    → orange (cap hit)
 *   otherwise (natural exit + error present)           → red
 */
export function colorFor(ctx: WebhookContext): number {
  if (ctx.ok) return COLOR_SUCCESS
  if (
    ctx.exitReason === 'max_iterations' ||
    ctx.exitReason === 'max_wall_clock' ||
    ctx.exitReason === 'max_total_tokens'
  ) {
    return COLOR_CAP
  }
  return COLOR_ERROR
}

// ------------------------------------------------------------------
// Pure adapters
// ------------------------------------------------------------------

export function toSlack(
  result: string,
  _usage: unknown,
  jobName: string,
  ctx: WebhookContext,
): { text: string } {
  const prefix = ctx.ok ? '' : `[${ctx.exitReason}] `
  return { text: `*${prefix}${jobName}*\n${truncate(result, SHORT_MAX)}` }
}

export interface DiscordEmbed {
  title: string
  color: number
  description: string
  footer: { text: string }
  timestamp: string
}

export interface DiscordBody {
  username: string
  avatar_url?: string
  embeds: DiscordEmbed[]
  content?: string
}

/**
 * Optional identity overrides for Discord webhook output. Threaded from the
 * `WebhookOutput` config through `pushWebhook` into `toDiscord` so each job
 * can present as its own app.
 */
export interface DiscordIdentity {
  /** Override for `username` field. Defaults to `kc ${jobName}`. */
  username?: string
  /** URL for `avatar_url` field. Must be publicly reachable. */
  avatarUrl?: string
}

// Discord allows up to 10 embeds per webhook message.
const MAX_EMBEDS = 10

/**
 * Parse a candidate JSON string as a Discord webhook payload. Returns the
 * narrowed payload if it has an `embeds` array, else null.
 */
function tryParseEmbedJson(
  s: string,
): { embeds: unknown[]; content?: string } | null {
  if (!s.startsWith('{')) return null
  try {
    const parsed = JSON.parse(s) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.embeds)) {
      return {
        embeds: parsed.embeds,
        ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
      }
    }
  } catch {
    // not valid JSON
  }
  return null
}

/**
 * Find a balanced `{...}` substring starting at `start`. String-aware so
 * braces inside JSON string values don't throw off the depth counter.
 * Returns null if braces never balance.
 */
function extractBalancedObject(s: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Detect an agent-produced Discord webhook payload. Tolerates three shapes:
 *   1. Clean JSON: result.md is exactly `{"embeds":[...]}`.
 *   2. Fenced code block: ```json\n{...}\n``` (with or without the `json` tag).
 *   3. JSON embedded in prose: scans for the first `{"embeds"` occurrence and
 *      extracts the balanced object around it.
 *
 * Returns null if no valid embed payload is found — caller falls back to the
 * legacy single-embed wrapper.
 *
 * This lets agents like daily-summary / my-agent render as native Discord
 * embeds instead of having their JSON stuffed into a description field, even
 * when the model ignores the "first char must be `{`" hard rule.
 */
export function tryParseAgentPayload(
  result: string,
): { embeds: unknown[]; content?: string } | null {
  if (!result) return null

  // 1. Whole string is JSON
  const direct = tryParseEmbedJson(result.trim())
  if (direct) return direct

  // 2. Fenced code block(s): try each in order
  const fenceRx = /```(?:json)?\s*([\s\S]*?)```/g
  for (const m of result.matchAll(fenceRx)) {
    const inner = (m[1] ?? '').trim()
    const parsed = tryParseEmbedJson(inner)
    if (parsed) return parsed
  }

  // 3. Scan for a raw `{"embeds"` somewhere in the text
  const idx = result.indexOf('{"embeds"')
  if (idx >= 0) {
    const candidate = extractBalancedObject(result, idx)
    if (candidate) {
      const parsed = tryParseEmbedJson(candidate)
      if (parsed) return parsed
    }
  }

  return null
}

export function toDiscord(
  result: string,
  _usage: unknown,
  jobName: string,
  ctx: WebhookContext,
  identity: DiscordIdentity = {},
): DiscordBody {
  const username = identity.username ?? `kc ${jobName}`
  const avatar = identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}

  // Success path: pass through agent-produced embed JSON if present.
  if (ctx.ok) {
    const agent = tryParseAgentPayload(result)
    if (agent) {
      // Shape is enforced by Discord server-side, not here — agents produce
      // freeform embed objects (fields, thumbnails, etc.) that don't always
      // match our internal DiscordEmbed interface. Cast through.
      return {
        username,
        ...avatar,
        embeds: agent.embeds.slice(0, MAX_EMBEDS) as DiscordEmbed[],
        ...(agent.content ? { content: agent.content } : {}),
      }
    }
  }

  // Legacy / failure path: wrap text (or error context) in a single embed.
  const title = ctx.ok ? jobName : `${jobName} FAILED`
  const color = colorFor(ctx)
  let description: string
  if (ctx.ok) {
    description = truncate(result, LONG_MAX)
  } else {
    const errPart = ctx.error ? `\n\n${truncate(ctx.error, 500)}` : ''
    description = `exit_reason: ${ctx.exitReason}${errPart}`
  }
  return {
    username,
    ...avatar,
    embeds: [
      {
        title,
        color,
        description,
        footer: { text: `exit_reason: ${ctx.exitReason}` },
        timestamp: new Date().toISOString(),
      },
    ],
  }
}

export function toNtfy(
  result: string,
  _usage: unknown,
  jobName: string,
  ctx: WebhookContext,
): string {
  const prefix = ctx.ok ? '' : `[${ctx.exitReason}] `
  return `${prefix}${jobName}\n\n${truncate(result, LONG_MAX)}`
}

export function toRaw(
  result: string,
  usage: unknown,
  jobName: string,
  ctx: WebhookContext,
): {
  job: string
  result: string
  usage: unknown
  ts: string
  exit_reason: ExitReason
  ok: boolean
  error: string | null
} {
  return {
    job: jobName,
    result: truncate(result, LONG_MAX),
    usage,
    ts: new Date().toISOString(),
    exit_reason: ctx.exitReason,
    ok: ctx.ok,
    error: ctx.error,
  }
}

// ------------------------------------------------------------------
// Log-tail enrichment for failure embeds
// ------------------------------------------------------------------

/**
 * Patterns that mark an informative log line — provider fallback summaries,
 * stderr error lines, capability/budget exhaustion notices, etc. Ordered
 * roughly by diagnostic value (most specific first).
 */
const LOG_INFO_PATTERNS = [
  /\[fallback\].*(?:failed|exhausted|switching)/i,
  /\[circuit\]/i,
  /\bRate limit\b/i,
  /\b(?:429|500|502|503|529)\b/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
  /\b(?:timed out|timeout)\b/i,
  /\bexhausted\b/i,
  /^Error:/,
]

/**
 * Read log.txt and return the last line matching a diagnostic pattern.
 * Returns null if log is missing/empty or no informative line found.
 */
export async function findInformativeLogLine(logPath: string): Promise<string | null> {
  let content: string
  try {
    content = await readFile(logPath, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n').filter((l) => l.trim())
  // Search newest first
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    for (const rx of LOG_INFO_PATTERNS) {
      if (rx.test(line)) return line.trim()
    }
  }
  return null
}

/**
 * Augment a vague error message with a log-tail line if one adds information.
 * Returns the enriched string, or null if no enrichment is possible/useful.
 *
 * Kept conservative: only augments when the existing error is short (<80 chars)
 * and generic, since longer messages usually already contain the useful detail.
 */
export async function tryEnrichError(
  logPath: string,
  existingError: string | null,
): Promise<string | null> {
  // Don't bother enriching long, already-informative errors
  if (existingError && existingError.length >= 80) return null
  const logLine = await findInformativeLogLine(logPath)
  if (!logLine) return null
  if (!existingError) return logLine
  // Avoid duplicating content that's already in the error
  if (existingError.includes(logLine) || logLine.includes(existingError)) {
    return logLine.length > existingError.length ? logLine : existingError
  }
  return `${existingError}\n\n[log] ${logLine}`
}

// ------------------------------------------------------------------
// Transport
// ------------------------------------------------------------------

/**
 * Best-effort webhook POST. Reads result.md + usage.json from the artifact
 * directory, builds a body via the chosen format adapter, and POSTs with a
 * 10s default timeout. Never throws — always resolves to WebhookResult.
 */
export async function pushWebhook(
  channel: WebhookOutput,
  artifacts: ArtifactPaths,
  jobName: string,
  ctx: WebhookContext,
  timeoutMs = 10_000,
): Promise<WebhookResult> {
  let resultText = ''
  let usage: unknown = {}
  try {
    resultText = await readFile(artifacts.resultPath, 'utf8')
  } catch {
    // partial run may have no result.md — send empty body
  }
  try {
    const raw = await readFile(artifacts.usagePath, 'utf8')
    usage = JSON.parse(raw)
  } catch {
    // usage.json missing or malformed — fall through with {}
  }

  // For failed runs: if ctx.error is generic (e.g. "Connection error."), try
  // to find a more informative line in log.txt (provider fallback summaries,
  // rate limit notices, stderr errors) and enrich the context so the Discord
  // embed shows actionable info instead of just "Connection error.".
  if (!ctx.ok) {
    const enriched = await tryEnrichError(artifacts.logPath, ctx.error)
    if (enriched !== null) {
      ctx = { ...ctx, error: enriched }
    }
  }

  let body: string
  let contentType: string
  switch (channel.format) {
    case 'slack':
      body = JSON.stringify(toSlack(resultText, usage, jobName, ctx))
      contentType = 'application/json'
      break
    case 'discord':
      body = JSON.stringify(
        toDiscord(resultText, usage, jobName, ctx, {
          username: channel.username,
          avatarUrl: channel.avatarUrl,
        }),
      )
      contentType = 'application/json'
      break
    case 'ntfy':
      body = toNtfy(resultText, usage, jobName, ctx)
      contentType = 'text/plain'
      break
    case 'raw':
      body = JSON.stringify(toRaw(resultText, usage, jobName, ctx))
      contentType = 'application/json'
      break
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: controller.signal,
    })
    if (res.ok) {
      return { ok: true, status: res.status }
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  } catch (err) {
    const e = err as Error & { name?: string }
    if (e?.name === 'AbortError') {
      return { ok: false, error: 'timeout' }
    }
    return { ok: false, error: e?.message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Persist a webhook attempt: POSTs via `pusher`, writes webhook.json in the
 * run directory, and appends a human-readable line to log.txt. Every I/O step
 * is try/caught — this helper NEVER throws and NEVER affects the caller's
 * control flow. Used by run-job.ts after artifacts are written.
 *
 * The `pusher` parameter is injectable so tests can provide a stub without
 * stubbing global fetch.
 */
export async function emitWebhookOutput(
  channel: WebhookOutput,
  artifacts: ArtifactPaths,
  jobName: string,
  ctx: WebhookContext,
  pusher: typeof pushWebhook = pushWebhook,
  now: () => Date = () => new Date(),
): Promise<void> {
  const attemptedAt = now().toISOString()
  let result: WebhookResult
  try {
    result = await pusher(channel, artifacts, jobName, ctx)
  } catch (err) {
    // pusher should never throw but belt-and-braces: fold into a result.
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    await writeFile(
      `${artifacts.runDir}/webhook.json`,
      JSON.stringify(
        {
          url: channel.url,
          format: channel.format,
          attempted_at: attemptedAt,
          exit_reason: ctx.exitReason,
          run_ok: ctx.ok,
          ...result,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch {
    // disk failure — ignore
  }
  const logLine = result.ok
    ? `webhook: ${channel.format} ok ${result.status}\n`
    : `webhook: ${channel.format} FAILED ${result.status ?? ''} ${result.error}\n`
  try {
    await appendFile(artifacts.logPath, logLine)
  } catch {
    // disk failure — ignore
  }
}
