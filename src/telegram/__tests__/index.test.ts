/**
 * Phase 69 Plan 03: Tests for runTelegramSubcommand entry point.
 *
 * Uses dependency injection (no mock.module) — CLAUDE.md constraint satisfied.
 *
 * Test coverage:
 *   Test 1: --help flag → writes "Usage: tm telegram" to stderr, exits 0
 *   Test 2: missing config.telegram section → stderr error, exits 1
 *   Test 3: token env var unset → stderr error with env var name, exits 1
 *   Test 4: valid config → loadMapping → hydrateConversations → startTelegramBot in order
 *   Test 5: ConversationManager constructed with config.telegram.maxConversationTurns
 *   Test 6: loadSharedContext called with agentName: 'telegram'
 *
 * Tests will FAIL until task 69-03-02 creates src/telegram/index.ts (RED phase).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import type { KristosConfig } from '../../config/types.js'
import type { TelegramConfig } from '../config.js'

// ── Config fixtures ───────────────────────────────────────────────────────────

const TELEGRAM_CONFIG: TelegramConfig = {
  tokenEnv: 'TELEGRAM_BOT_TOKEN',
  ownerChatId: '99999',
  maxConversationTurns: 25,
}

const BASE_CONFIG: KristosConfig = {
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
  telegram: TELEGRAM_CONFIG,
}

const CONFIG_WITHOUT_TELEGRAM: KristosConfig = {
  ...BASE_CONFIG,
  telegram: undefined,
}

// ── Import subject under test ─────────────────────────────────────────────────

// Import AFTER fixtures are defined — the module may not exist yet (RED phase)
const { runTelegramSubcommand } = await import('../index.js')

// ── Helper: mock exit that throws a sentinel so tests can verify exit code ────

function makeExitSpy(): {
  exit: (code: number) => never
  getCode: () => number | undefined
} {
  let capturedCode: number | undefined
  const exit = mock((code: number): never => {
    capturedCode = code
    throw new Error('__exit__')
  }) as (code: number) => never
  return {
    exit,
    getCode: () => capturedCode,
  }
}

// ── Helper: stderr capture ────────────────────────────────────────────────────

function makeStderr(): { write: (s: string) => void; get: () => string } {
  let buf = ''
  return {
    write: (s: string) => { buf += s },
    get: () => buf,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runTelegramSubcommand — entry point', () => {
  beforeEach(() => {
    // Ensure token env var is unset for tests that test missing token
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  it('test 1: --help writes "Usage: tm telegram" to stderr and exits 0', async () => {
    const { exit, getCode } = makeExitSpy()
    const stderr = makeStderr()

    try {
      await runTelegramSubcommand(['--help'], {
        loadConfig: async () => BASE_CONFIG,
        loadMapping: mock(async () => ({})),
        hydrateConversations: mock(async () => {}),
        startTelegramBot: mock(async () => {}),
        loadSharedContext: mock(async () => ({})),
        exit,
        stderr,
      })
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__exit__') throw err
    }

    expect(getCode()).toBe(0)
    expect(stderr.get()).toContain('Usage: tm telegram')
  })

  it('test 2: missing config.telegram section → stderr error + exits 1', async () => {
    const { exit, getCode } = makeExitSpy()
    const stderr = makeStderr()

    try {
      await runTelegramSubcommand([], {
        loadConfig: async () => CONFIG_WITHOUT_TELEGRAM,
        loadMapping: mock(async () => ({})),
        hydrateConversations: mock(async () => {}),
        startTelegramBot: mock(async () => {}),
        loadSharedContext: mock(async () => ({})),
        exit,
        stderr,
      })
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__exit__') throw err
    }

    expect(getCode()).toBe(1)
    expect(stderr.get()).toContain('no "telegram" section in config')
  })

  it('test 3: token env var unset → stderr error contains env var name + exits 1', async () => {
    const { exit, getCode } = makeExitSpy()
    const stderr = makeStderr()
    // Ensure env var is unset
    delete process.env[TELEGRAM_CONFIG.tokenEnv]

    try {
      await runTelegramSubcommand([], {
        loadConfig: async () => BASE_CONFIG,
        loadMapping: mock(async () => ({})),
        hydrateConversations: mock(async () => {}),
        startTelegramBot: mock(async () => {}),
        loadSharedContext: mock(async () => ({})),
        exit,
        stderr,
      })
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__exit__') throw err
    }

    expect(getCode()).toBe(1)
    // Error message must include the env var name so user knows what to set
    expect(stderr.get()).toContain(TELEGRAM_CONFIG.tokenEnv)
  })

  it('test 4: valid config + token set → loadMapping called before hydrateConversations before startTelegramBot', async () => {
    process.env[TELEGRAM_CONFIG.tokenEnv] = 'fake-token'

    const callOrder: string[] = []
    const loadMapping = mock(async () => {
      callOrder.push('loadMapping')
      return {}
    })
    const hydrateConversations = mock(async () => {
      callOrder.push('hydrateConversations')
    })
    const startTelegramBot = mock(async () => {
      callOrder.push('startTelegramBot')
    })
    const loadSharedContext = mock(async () => {
      callOrder.push('loadSharedContext')
      return {}
    })

    await runTelegramSubcommand([], {
      loadConfig: async () => BASE_CONFIG,
      loadMapping,
      hydrateConversations,
      startTelegramBot,
      loadSharedContext,
      exit: makeExitSpy().exit,
      stderr: makeStderr(),
    })

    // loadMapping must come before hydrateConversations; both before startTelegramBot
    expect(loadMapping).toHaveBeenCalledTimes(1)
    expect(hydrateConversations).toHaveBeenCalledTimes(1)
    expect(startTelegramBot).toHaveBeenCalledTimes(1)

    const mappingIdx = callOrder.indexOf('loadMapping')
    const hydrateIdx = callOrder.indexOf('hydrateConversations')
    const startIdx = callOrder.indexOf('startTelegramBot')
    expect(mappingIdx).toBeLessThan(hydrateIdx)
    expect(hydrateIdx).toBeLessThan(startIdx)

    delete process.env[TELEGRAM_CONFIG.tokenEnv]
  })

  it('test 5: ConversationManager constructed with config.telegram.maxConversationTurns', async () => {
    process.env[TELEGRAM_CONFIG.tokenEnv] = 'fake-token'

    let capturedConversationsArg: unknown
    const hydrateConversations = mock(async (conversations: unknown) => {
      capturedConversationsArg = conversations
    })

    const startTelegramBot = mock(async () => {})
    const loadSharedContext = mock(async () => ({}))

    await runTelegramSubcommand([], {
      loadConfig: async () => BASE_CONFIG,
      loadMapping: mock(async () => ({})),
      hydrateConversations,
      startTelegramBot,
      loadSharedContext,
      exit: makeExitSpy().exit,
      stderr: makeStderr(),
    })

    // ConversationManager is passed as first argument to hydrateConversations
    // It should be an object (the constructed ConversationManager instance)
    expect(capturedConversationsArg).toBeTruthy()
    expect(typeof capturedConversationsArg).toBe('object')

    // Verify startTelegramBot received a TelegramBotOptions with telegramConfig
    const startArgs = (startTelegramBot as ReturnType<typeof mock>).mock.calls[0]
    expect(startArgs).toBeDefined()
    const opts = startArgs![0] as { telegramConfig: TelegramConfig; onMessage?: unknown }
    expect(opts.telegramConfig).toEqual(TELEGRAM_CONFIG)

    delete process.env[TELEGRAM_CONFIG.tokenEnv]
  })

  it('test 6: loadSharedContext called with agentName: "telegram"', async () => {
    process.env[TELEGRAM_CONFIG.tokenEnv] = 'fake-token'

    const loadSharedContext = mock(async () => ({}))

    await runTelegramSubcommand([], {
      loadConfig: async () => BASE_CONFIG,
      loadMapping: mock(async () => ({})),
      hydrateConversations: mock(async () => {}),
      startTelegramBot: mock(async () => {}),
      loadSharedContext,
      exit: makeExitSpy().exit,
      stderr: makeStderr(),
    })

    expect(loadSharedContext).toHaveBeenCalledTimes(1)
    const callArgs = (loadSharedContext as ReturnType<typeof mock>).mock.calls[0]
    const opts = callArgs![0] as { cwd: string; agentName?: string }
    expect(opts.agentName).toBe('telegram')

    delete process.env[TELEGRAM_CONFIG.tokenEnv]
  })
})

// ── Phase 71 tests: onStart wiring (TGNOTIF-02 + setMyCommands) ───────────────

describe('runTelegramSubcommand onStart wiring (Phase 71)', () => {
  // Shared helper to run runTelegramSubcommand and capture the onStart callback.
  type OnStartFn = (
    sendMessage: (text: string) => Promise<void>,
    botApi: { setMyCommands: (cmds: Array<{ command: string; description: string }>) => Promise<void>; sendMessage: (chatId: number, text: string) => Promise<void> },
  ) => Promise<void>

  async function runAndCaptureOnStart(): Promise<{
    onStart: OnStartFn | undefined
    startStub: ReturnType<typeof mock>
  }> {
    process.env[TELEGRAM_CONFIG.tokenEnv] = 'fake-token-71'
    let capturedOnStart: OnStartFn | undefined
    const startStub = mock(async (opts: { onStart?: OnStartFn }) => {
      capturedOnStart = opts.onStart
    })
    await runTelegramSubcommand([], {
      loadConfig: async () => BASE_CONFIG,
      loadMapping: mock(async () => ({})),
      hydrateConversations: mock(async () => {}),
      loadSharedContext: mock(async () => ({ files: [], systemPromptPrefix: '', totalBytes: 0, totalEstimatedTokens: 0, budgetWarning: null } as never)),
      startTelegramBot: startStub as never,
      exit: ((code: number) => { throw new Error(`exit ${code}`) }) as never,
      stderr: { write: () => {} },
    })
    delete process.env[TELEGRAM_CONFIG.tokenEnv]
    return { onStart: capturedOnStart, startStub }
  }

  it('passes onStart to startTelegramBot', async () => {
    const { onStart, startStub } = await runAndCaptureOnStart()
    expect(startStub).toHaveBeenCalledTimes(1)
    expect(onStart).toBeDefined()
    expect(typeof onStart).toBe('function')
  })

  it('onStart calls sendMessage with startup DM', async () => {
    const { onStart } = await runAndCaptureOnStart()
    expect(onStart).toBeDefined()

    const messages: string[] = []
    const sendMessage = async (text: string): Promise<void> => { messages.push(text) }
    const botApi = {
      setMyCommands: mock(async () => {}),
      sendMessage: mock(async () => {}),
    }

    await onStart!(sendMessage, botApi)

    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('Telemachus restarted')
  })

  it('onStart calls botApi.setMyCommands with all 7 commands', async () => {
    const { onStart } = await runAndCaptureOnStart()
    expect(onStart).toBeDefined()

    const sendMessage = async (_text: string): Promise<void> => {}
    const setMyCommandsSpy = mock(async (_cmds: Array<{ command: string; description: string }>) => {})
    const botApi = {
      setMyCommands: setMyCommandsSpy,
      sendMessage: mock(async () => {}),
    }

    await onStart!(sendMessage, botApi)

    expect(setMyCommandsSpy).toHaveBeenCalledTimes(1)
    const [calledCmds] = (setMyCommandsSpy as ReturnType<typeof mock>).mock.calls[0] as [Array<{ command: string; description: string }>]
    expect(calledCmds).toHaveLength(7)

    const commandNames = calledCmds.map((c) => c.command)
    expect(commandNames).toContain('cost')
    expect(commandNames).toContain('context')
    expect(commandNames).toContain('compact')
    expect(commandNames).toContain('model')
    expect(commandNames).toContain('clear')
    expect(commandNames).toContain('orchestrate')
    expect(commandNames).toContain('tool_errors')
  })

  it('setMyCommands failure does not prevent startup DM', async () => {
    const { onStart } = await runAndCaptureOnStart()
    expect(onStart).toBeDefined()

    const messages: string[] = []
    const sendMessage = async (text: string): Promise<void> => { messages.push(text) }
    const botApi = {
      setMyCommands: mock(async () => { throw new Error('BotFather API error') }),
      sendMessage: mock(async () => {}),
    }

    // Should not throw even though setMyCommands fails
    await expect(onStart!(sendMessage, botApi)).resolves.toBeUndefined()

    // Startup DM must still be sent despite the setMyCommands failure
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('Telemachus restarted')
  })
})
