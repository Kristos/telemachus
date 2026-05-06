/**
 * `!deploy` Discord command — one-shot approval-gated commit + push + open PR.
 *
 * Usage:
 *   !deploy <commit message>
 *
 * Behavior:
 *   1. Parse the commit message from everything after "!deploy ".
 *   2. Build a Discord-channel askUser callback backed by a module-level
 *      resolver (mirrors the plan-approval / wave-fail-fast pattern from v3.0+).
 *   3. Invoke gitDeployTool — the tool posts the formatted approval prompt
 *      via msg.reply (through askUser), then awaits the user's next reply.
 *   4. Intercept reply via `resolveDeployReply` (called from bot.ts), map
 *      yes/no to the askUser promise.
 *
 * This is human-initiated only — NOT triggered by agent tool calls. Those
 * would need a different wiring (see v3.3+ for the agent-initiated path).
 */

import type { DiscordMessage } from './runner.js'
import { gitDeployTool } from '../tools/builtin/git-deploy.js'
import type { ToolContext } from '../tools/types.js'

// ── Module-level resolver for the deploy approval prompt ─────────────────────

let _pendingDeployApproval: ((answer: string) => void) | null = null
let _pendingDeployTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Called by bot.ts when a message arrives while a deploy approval is pending.
 * Returns true if the message was consumed (bot should NOT route further).
 */
export function resolveDeployReply(content: string): boolean {
  if (_pendingDeployApproval === null) return false
  const normalized = content.toLowerCase().trim()
  // Accept a wide set of affirmative / negative replies — user convenience.
  const YES = new Set(['yes', 'y', 'approve', 'ok', 'ship', 'ship it', 'deploy'])
  const NO = new Set(['no', 'n', 'reject', 'cancel', 'abort', 'stop'])
  if (!YES.has(normalized) && !NO.has(normalized)) return false

  const resolver = _pendingDeployApproval
  _pendingDeployApproval = null
  if (_pendingDeployTimer !== null) {
    clearTimeout(_pendingDeployTimer)
    _pendingDeployTimer = null
  }
  resolver(YES.has(normalized) ? 'yes' : 'no')
  return true
}

const DEPLOY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

// ── `!deploy` handler ────────────────────────────────────────────────────────

export async function handleDeployCommand(msg: DiscordMessage): Promise<void> {
  const raw = msg.content.trim()
  const prefix = '!deploy'
  const rest = raw.startsWith(prefix + ' ')
    ? raw.slice(prefix.length + 1).trim()
    : raw === prefix
      ? ''
      : raw.slice(prefix.length).trim()

  if (!rest || rest === '--help' || rest === '-h' || rest === 'help') {
    await msg.reply(
      [
        '**Usage:** `!deploy <commit message>`',
        '',
        'I will:',
        '1. Show you the current diff, target branch (`agent/<slug>`), and auto-generated PR title/body',
        '2. Wait for you to reply `yes` to approve or `no` to cancel',
        '3. On approve: commit + push + open PR',
        '',
        'This only works from the machine where the bot is running — make sure you have the right changes staged there.',
      ].join('\n'),
    )
    return
  }

  const commitMessage = rest
  const prTitle = commitMessage.split('\n')[0]
  const prBody = `${commitMessage}\n\n_Opened via \`!deploy\` on Discord._`

  // Discord askUser: post the question as a reply, then await a resolver.
  const askUser = async (question: string, _options: string[]): Promise<string> => {
    if (_pendingDeployApproval !== null) {
      throw new Error('A deploy approval is already pending. Wait for it to resolve first.')
    }

    // Post the formatted prompt. Truncate if over Discord's 2000 char cap.
    const fullMsg = question + '\n\nReply **yes** to deploy or **no** to cancel (5 minute timeout).'
    const chunks = chunkForDiscord(fullMsg)
    for (const chunk of chunks) {
      await msg.reply(chunk)
    }

    return new Promise<string>((resolve) => {
      _pendingDeployApproval = resolve
      _pendingDeployTimer = setTimeout(() => {
        if (_pendingDeployApproval !== null) {
          _pendingDeployApproval = null
          _pendingDeployTimer = null
          resolve('no')
        }
      }, DEPLOY_APPROVAL_TIMEOUT_MS)
    })
  }

  const ctx: ToolContext = {
    cwd: process.cwd(),
    toolTimeoutMs: 60_000,
    askUser,
    sessionId: `kc-deploy-discord-${Date.now()}`,
    source: 'discord',
    discordUserId: msg.authorId,
    discordChannelId: msg.channelId,
  }

  try {
    const result = await gitDeployTool.execute(
      { commitMessage, prTitle, prBody },
      ctx,
    )
    const chunks = chunkForDiscord(result.content)
    for (const chunk of chunks) {
      await msg.reply(chunk)
    }
  } catch (err) {
    await msg.reply(
      `Deploy failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    // Defensive cleanup — always clear any lingering pending state.
    if (_pendingDeployApproval !== null) {
      _pendingDeployApproval = null
    }
    if (_pendingDeployTimer !== null) {
      clearTimeout(_pendingDeployTimer)
      _pendingDeployTimer = null
    }
  }
}

/** Split a long message into Discord-safe (<2000 char) chunks on line boundaries. */
export function chunkForDiscord(text: string, max = 1900): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  const lines = text.split('\n')
  let current = ''
  for (const line of lines) {
    if (current.length + line.length + 1 > max) {
      if (current) chunks.push(current)
      current = line
    } else {
      current = current ? current + '\n' + line : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}
