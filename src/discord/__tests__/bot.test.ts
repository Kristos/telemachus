/**
 * Phase 31-03 (updated from Phase 30-02): Unit tests for Discord bot security gates.
 * Tests: SEC-10 (intents), SEC-11 (allowlist), SEC-12 (token env var), CFG-01 (profile).
 *
 * Phase 31 changes:
 *   - BotOptions now requires onMessage handler (no more echo)
 *   - Tests inject onMessageSpy; SEC-11 test verifies it's called for allowed users
 *   - Profile logging moved to index.ts; CFG-01 test kept here as no-op banner check
 *
 * Phase 34-02 changes (OPS-03):
 *   - Options mock added (Phase 34-01 introduced Options.cacheWithLimits in bot.ts)
 *   - CapturedClient extended with makeCache + sweepers fields
 *   - OPS-03 test verifies Client receives makeCache and sweepers from startDiscordBot
 *
 * Uses mock.module to intercept discord.js Client so we can:
 *   - Capture constructor args (intents, makeCache, sweepers)
 *   - Capture event handler registrations
 *   - Control client.login() without hitting the network
 *   - Invoke event handlers directly in tests
 *
 * discord.js is mocked at the module level because it is not installed as a
 * package dependency (it's bundled at compile time via bun build --compile).
 */
import { describe, expect, it, mock, beforeEach } from 'bun:test'
import type { KristosConfig } from '../../config/types.js'
import type { DiscordConfig } from '../config.js'
import { resetQueueForTest } from '../turn-queue.js'

// Reset turn-queue module state between tests so leaked activeTurns from
// any prior test (or test file in the same bun worker) don't make
// hasPendingTurns() return true and force shutdown to await drainAllTurns.
beforeEach(() => {
  resetQueueForTest()
})

// ── discord.js mock ──────────────────────────────────────────────────────────

interface CapturedClient {
  constructorArgs: {
    intents: number[]
    makeCache?: unknown
    sweepers?: unknown
  }
  handlers: Record<string, (...args: unknown[]) => unknown>
  loginMock: ReturnType<typeof mock>
  destroyMock: ReturnType<typeof mock>
}

// Shared registry updated each time a new Client is constructed.
const clientRegistry: { current: CapturedClient | null } = { current: null }

mock.module('discord.js', () => {
  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 512,
    DirectMessages: 4096,
    MessageContent: 32768,
  }

  const Events = {
    ClientReady: 'ready',
    MessageCreate: 'messageCreate',
  }

  // Options mock: cacheWithLimits and DefaultMakeCacheSettings/DefaultSweeperSettings
  // are used in bot.ts (OPS-03). We return identity/passthrough values so the
  // Client constructor args can be inspected.
  const Options = {
    cacheWithLimits: (settings: Record<string, unknown>) => settings,
    DefaultMakeCacheSettings: {},
    DefaultSweeperSettings: {},
  }

  function Client(
    this: Record<string, unknown>,
    opts: { intents: number[]; makeCache?: unknown; sweepers?: unknown },
  ) {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {}
    const loginMock = mock(async (_token: string) => undefined)
    const destroyMock = mock(() => undefined)

    this.on = (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler
    }
    this.login = loginMock
    this.destroy = destroyMock
    this.user = { id: 'bot-user-id', tag: 'bot#0001' }

    clientRegistry.current = { constructorArgs: opts, handlers, loginMock, destroyMock }
  }

  const Partials = { Channel: 'Channel', Message: 'Message', Reaction: 'Reaction' }
  const ChannelType = { DM: 1, GuildText: 0, PublicThread: 11, PrivateThread: 12 }

  return { Client, GatewayIntentBits, Events, Options, Partials, ChannelType }
})

// Import AFTER mock.module so the module uses the mocked discord.js
const { startDiscordBot } = await import('../bot.js')

// ── helpers ──────────────────────────────────────────────────────────────────

function makeConfig(extra: Partial<KristosConfig> = {}): KristosConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    contextTokenBudget: 8000,
    maxInflightLLMRequests: 4,
    providerConfigs: {
      anthropic: { model: 'claude-sonnet-4-6' },
      llamacpp: { model: 'glm-4.7-flash', baseURL: 'http://localhost:8080/v1' },
    },
    ...extra,
  }
}

const BASE_DISCORD_CFG: DiscordConfig = {
  tokenEnv: 'KC_DISCORD_TOKEN_TEST',
  allowedUsers: ['user-allowed-123'],
}

/** Default no-op onMessage handler for tests that don't care about message routing. */
const noopOnMessage = mock(async () => {})

/**
 * Start the bot, then emit SIGINT to resolve the blocking promise.
 * Returns the captured mock client state.
 */
async function startBotAndCapture(
  config: KristosConfig,
  discordConfig: DiscordConfig = BASE_DISCORD_CFG,
  onMessage = noopOnMessage,
): Promise<CapturedClient> {
  clientRegistry.current = null

  const botPromise = startDiscordBot({ config, discordConfig, onMessage })

  // Let the bot register handlers and reach the blocking promise
  await new Promise<void>((r) => setTimeout(r, 15))
  process.emit('SIGINT' as NodeJS.Signals)

  await botPromise

  const captured = clientRegistry.current
  if (!captured) throw new Error('Mock Client was never constructed')
  return captured
}

// ── SEC-12: Token validation ──────────────────────────────────────────────────

describe('SEC-12: Discord bot token validation', () => {
  it('throws with env var name when token is undefined', async () => {
    const prev = process.env.KC_DISCORD_TOKEN_TEST
    delete process.env.KC_DISCORD_TOKEN_TEST

    try {
      await expect(
        startDiscordBot({
          config: makeConfig(),
          discordConfig: { tokenEnv: 'KC_DISCORD_TOKEN_TEST', allowedUsers: ['123'] },
          onMessage: async () => {},
        }),
      ).rejects.toThrow('KC_DISCORD_TOKEN_TEST')
    } finally {
      if (prev !== undefined) process.env.KC_DISCORD_TOKEN_TEST = prev
    }
  })

  it('throws with env var name when token is empty string', async () => {
    const prev = process.env.KC_DISCORD_TOKEN_TEST
    process.env.KC_DISCORD_TOKEN_TEST = ''

    try {
      await expect(
        startDiscordBot({
          config: makeConfig(),
          discordConfig: { tokenEnv: 'KC_DISCORD_TOKEN_TEST', allowedUsers: ['123'] },
          onMessage: async () => {},
        }),
      ).rejects.toThrow('KC_DISCORD_TOKEN_TEST')
    } finally {
      if (prev !== undefined) process.env.KC_DISCORD_TOKEN_TEST = prev
      else delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })
})

// ── SEC-10: Intents ───────────────────────────────────────────────────────────

describe('SEC-10: Client constructed with all four intents', () => {
  it('includes Guilds, GuildMessages, DirectMessages, MessageContent', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-intents'
    try {
      const client = await startBotAndCapture(makeConfig())
      // GatewayIntentBits mock values: Guilds=1, GuildMessages=512, DirectMessages=4096, MessageContent=32768
      expect(client.constructorArgs.intents).toContain(1)
      expect(client.constructorArgs.intents).toContain(512)
      expect(client.constructorArgs.intents).toContain(4096)
      expect(client.constructorArgs.intents).toContain(32768)
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })
})

// ── SEC-11: Allowlist enforcement ─────────────────────────────────────────────

describe('SEC-11: messageCreate allowlist enforcement', () => {
  it('ignores messages from bot accounts (author.bot = true)', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-bot-ignore'
    try {
      const onMessageSpy = mock(async () => {})
      const client = await startBotAndCapture(makeConfig(), BASE_DISCORD_CFG, onMessageSpy)
      await client.handlers['messageCreate']({
        author: { bot: true, id: 'user-allowed-123' },
        content: 'hello',
        channelId: 'ch-1',
        guild: null,
        channel: { sendTyping: async () => {} },
        reply: async () => {},
      })
      expect(onMessageSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })

  it('ignores messages from non-allowlisted users', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-non-owner'
    try {
      const onMessageSpy = mock(async () => {})
      const client = await startBotAndCapture(makeConfig(), BASE_DISCORD_CFG, onMessageSpy)
      await client.handlers['messageCreate']({
        author: { bot: false, id: 'NOT-in-allowlist-999' },
        content: 'hello',
        channelId: 'ch-2',
        guild: null,
        channel: { sendTyping: async () => {} },
        reply: async () => {},
      })
      expect(onMessageSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })

  it('calls onMessage for messages from allowlisted users', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-allowed'
    try {
      const onMessageSpy = mock(async () => {})
      const client = await startBotAndCapture(makeConfig(), BASE_DISCORD_CFG, onMessageSpy)
      await client.handlers['messageCreate']({
        author: { bot: false, id: 'user-allowed-123' },
        content: 'hello bot',
        channelId: 'ch-dm',
        guild: null,  // null = DM
        channel: { type: 1, sendTyping: async () => {}, send: async () => {} }, // type 1 = ChannelType.DM
        attachments: new Map(),
        mentions: { has: () => false },
        reply: async () => {},
      })
      expect(onMessageSpy).toHaveBeenCalledTimes(1)
      // Verify DiscordMessage shape passed to handler
      const discordMsg = (onMessageSpy.mock.calls[0] as unknown as [import('../runner.js').DiscordMessage])[0]
      expect(discordMsg.content).toBe('hello bot')
      expect(discordMsg.authorId).toBe('user-allowed-123')
      expect(discordMsg.isGuild).toBe(false)
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })
})

// ── CFG-01: Profile resolution ────────────────────────────────────────────────
// Note: Profile logging moved to index.ts in Phase 31. This test verifies
// the bot still starts cleanly when a discord profile is configured.

describe('CFG-01: Bot starts with discord profile configured', () => {
  it('starts without error when discord profile activates llamacpp', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-profile'

    try {
      const configWithProfile = makeConfig({
        profiles: {
          discord: { provider: 'llamacpp', model: 'glm-4.7-flash' },
        },
      })
      // Should not throw — just verifies bot starts without crashing on profile config
      await startBotAndCapture(configWithProfile, {
        tokenEnv: 'KC_DISCORD_TOKEN_TEST',
        allowedUsers: ['123'],
        profile: 'discord',
      })
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })
})

// ── OPS-03: Message cache cap ─────────────────────────────────────────────────

describe('OPS-03: Client is constructed with makeCache and sweepers', () => {
  it('passes makeCache option to Client constructor', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-cache'
    try {
      const client = await startBotAndCapture(makeConfig())
      // makeCache should be truthy — Options.cacheWithLimits returns the settings object
      expect(client.constructorArgs.makeCache).toBeTruthy()
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })

  it('passes sweepers option with messages key to Client constructor', async () => {
    process.env.KC_DISCORD_TOKEN_TEST = 'tok-sweepers'
    try {
      const client = await startBotAndCapture(makeConfig())
      expect(client.constructorArgs.sweepers).toBeTruthy()
      const sweepers = client.constructorArgs.sweepers as Record<string, unknown>
      expect(sweepers).toHaveProperty('messages')
    } finally {
      delete process.env.KC_DISCORD_TOKEN_TEST
    }
  })
})
