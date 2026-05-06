/**
 * Phase 30-02: Unit tests for Discord subcommand dispatcher validation.
 * Tests: help flag exit, missing config error, empty allowlist error.
 *
 * Note: All three test paths exit before reaching startDiscordBot, so
 * we do NOT mock bot.js — avoiding module registry pollution for bot.test.ts.
 * We DO stub discord.js because the module graph (index→bot→discord.js)
 * must resolve cleanly even though discord.js is not installed as a package.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { KristosConfig } from '../../config/types.js'

// ── Config fixture ────────────────────────────────────────────────────────

const DEFAULT_CONFIG_BASE: KristosConfig = {
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
}

// Mutable config controlled per test
let mockedConfig: KristosConfig = { ...DEFAULT_CONFIG_BASE }

// Stub loadConfig so tests control what config is returned
mock.module('../../config/loader.js', () => ({
  loadConfig: async (_cwd: string) => mockedConfig,
}))

// Stub discord.js so the transitive import chain (index→bot→discord.js)
// resolves cleanly. None of the index tests reach startDiscordBot.
mock.module('discord.js', () => ({
  Client: class {},
  GatewayIntentBits: {},
  Events: {},
  Partials: {},
  ChannelType: {},
  Options: { defaultMakeCacheSettings: {} },
}))

// Import after mocks are registered
const { runDiscordSubcommand } = await import('../index.js')

// ── Helpers ────────────────────────────────────────────────────────────────

/** Intercept process.stderr.write and process.exit for assertion. */
function interceptOutput(): {
  getStderr: () => string
  getExitCode: () => number | null
  restore: () => void
} {
  const lines: string[] = []
  let exitCode: number | null = null

  const origWrite = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  const origExit = process.exit.bind(process)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process as any).exit = (code?: number) => {
    exitCode = code ?? 0
    throw new Error(`__process_exit_${code ?? 0}__`)
  }

  return {
    getStderr: () => lines.join(''),
    getExitCode: () => exitCode,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = origWrite
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process as any).exit = origExit
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runDiscordSubcommand: input validation', () => {
  beforeEach(() => {
    mockedConfig = { ...DEFAULT_CONFIG_BASE }
  })

  it('--help writes usage text and calls process.exit(0)', async () => {
    const io = interceptOutput()
    let caught: Error | undefined
    try {
      await runDiscordSubcommand(['--help'])
    } catch (err) {
      caught = err as Error
    } finally {
      io.restore()
    }

    expect(caught?.message).toContain('__process_exit_0__')
    expect(io.getStderr()).toContain('Usage: tm discord')
    expect(io.getExitCode()).toBe(0)
  })

  it('missing discord config writes error with no "discord" section and exits 1', async () => {
    // No discord field in config (default base config)
    const io = interceptOutput()
    let caught: Error | undefined
    try {
      await runDiscordSubcommand([])
    } catch (err) {
      caught = err as Error
    } finally {
      io.restore()
    }

    expect(caught?.message).toContain('__process_exit_1__')
    expect(io.getStderr()).toContain('no "discord" section')
    expect(io.getExitCode()).toBe(1)
  })

  it('empty allowedUsers writes error with "allowedUsers is empty" and exits 1', async () => {
    mockedConfig = {
      ...DEFAULT_CONFIG_BASE,
      discord: {
        tokenEnv: 'KC_DISCORD_TOKEN',
        allowedUsers: [], // empty — bot would ignore all messages
      },
    }

    const io = interceptOutput()
    let caught: Error | undefined
    try {
      await runDiscordSubcommand([])
    } catch (err) {
      caught = err as Error
    } finally {
      io.restore()
    }

    expect(caught?.message).toContain('__process_exit_1__')
    expect(io.getStderr()).toContain('allowedUsers is empty')
    expect(io.getExitCode()).toBe(1)
  })
})
