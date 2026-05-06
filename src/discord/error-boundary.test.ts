/**
 * Phase 65 (HYG-01): Tests for error-boundary.ts — per-turn try/catch/finally
 * wrapper. Verifies error replies, finally-block writer.stop(), turn_summary
 * write gated on agg > 0, and closure-safe getContextSizeTokens() reads.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapTurnExecution, type TurnContext } from './error-boundary.js'
import * as turnSummaryStore from './turn-summary-store.js'
import type { ReplyWriter } from './reply-writer.js'

function makeWriterSpy(): ReplyWriter & {
  __errorCalls: string[]
  __stopCalls: number
  __finalizeCalls: string[]
} {
  const __errorCalls: string[] = []
  let __stopCalls = 0
  const __finalizeCalls: string[] = []
  return {
    start: async () => {},
    appendChunk: () => {},
    finalize: async (text: string) => { __finalizeCalls.push(text) },
    replyError: async (text: string) => { __errorCalls.push(text) },
    stop: () => { __stopCalls++ },
    getBuffer: () => '',
    __errorCalls,
    get __stopCalls() { return __stopCalls },
    __finalizeCalls,
  } as ReplyWriter & {
    __errorCalls: string[]
    __stopCalls: number
    __finalizeCalls: string[]
  }
}

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext & {
  _writer: ReplyWriter & { __errorCalls: string[]; __stopCalls: number; __finalizeCalls: string[] }
} {
  const writer = makeWriterSpy()
  const ctx: TurnContext = {
    writer,
    turnId: 'turn-1',
    agg: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    routerSession: {},
    channelId: 'ch-1',
    userId: 'user-1',
    defaultModel: 'glm-4.6',
    transport: 'discord' as const,
    getContextSizeTokens: () => undefined,
    ...overrides,
  }
  return { ...ctx, _writer: writer } as TurnContext & {
    _writer: ReplyWriter & { __errorCalls: string[]; __stopCalls: number; __finalizeCalls: string[] }
  }
}

let appendTurnSummarySpy: ReturnType<typeof spyOn>
let tmpHome: string
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.HOME
  tmpHome = await mkdtemp(join(tmpdir(), 'kc-errbound-test-'))
  process.env.HOME = tmpHome
  appendTurnSummarySpy = spyOn(turnSummaryStore, 'appendTurnSummary').mockResolvedValue(undefined)
})

afterEach(async () => {
  appendTurnSummarySpy.mockRestore()
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  await rm(tmpHome, { recursive: true, force: true })
})

describe('wrapTurnExecution', () => {
  it('runs body to completion when no error', async () => {
    const ctx = makeCtx()
    let ran = false

    await wrapTurnExecution(ctx, async () => { ran = true })

    expect(ran).toBe(true)
    expect(ctx._writer.__errorCalls).toEqual([])
    expect(ctx._writer.__stopCalls).toBe(1)
  })

  it('catch path posts error reply via writer.replyError', async () => {
    const ctx = makeCtx()

    await wrapTurnExecution(ctx, async () => {
      throw new Error('runSubagent exploded')
    })

    expect(ctx._writer.__errorCalls).toEqual(['Agent error: runSubagent exploded'])
    expect(ctx._writer.__stopCalls).toBe(1)
  })

  it('catch path tolerates non-Error throwables (string)', async () => {
    const ctx = makeCtx()

    await wrapTurnExecution(ctx, async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'naked string error'
    })

    expect(ctx._writer.__errorCalls).toEqual(['Agent error: naked string error'])
  })

  it('finally writes turn_summary when agg has tokens', async () => {
    const ctx = makeCtx({
      agg: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.001,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    await wrapTurnExecution(ctx, async () => {})

    expect(appendTurnSummarySpy).toHaveBeenCalledTimes(1)
    const summary = appendTurnSummarySpy.mock.calls[0]![0] as {
      totalInputTokens: number
      totalOutputTokens: number
      turnId: string
    }
    expect(summary.totalInputTokens).toBe(500)
    expect(summary.totalOutputTokens).toBe(200)
    expect(summary.turnId).toBe('turn-1')
  })

  it('finally skips turn_summary when agg is empty', async () => {
    const ctx = makeCtx()  // default agg all zeros

    await wrapTurnExecution(ctx, async () => {})

    expect(appendTurnSummarySpy).not.toHaveBeenCalled()
  })

  it('finally writes turn_summary even when body throws (partial-usage-on-abort)', async () => {
    const ctx = makeCtx({
      agg: {
        inputTokens: 300,
        outputTokens: 100,
        costUsd: 0.0005,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    await wrapTurnExecution(ctx, async () => {
      // simulate a failure AFTER onTurnComplete populated agg
      throw new Error('post-usage failure')
    })

    expect(appendTurnSummarySpy).toHaveBeenCalledTimes(1)
    expect(ctx._writer.__errorCalls).toEqual(['Agent error: post-usage failure'])
  })

  it('getContextSizeTokens() is called at finally-time (closure-safe)', async () => {
    let currentSize: number | undefined = undefined
    const ctx = makeCtx({
      agg: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.001,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      getContextSizeTokens: () => currentSize,
    })

    await wrapTurnExecution(ctx, async () => {
      // Body assigns closure-scoped value mid-turn — finally should see it.
      currentSize = 42_000
    })

    const summary = appendTurnSummarySpy.mock.calls[0]![0] as { contextSizeTokens?: number }
    expect(summary.contextSizeTokens).toBe(42_000)
  })

  it('getContextSizeTokens() returning undefined omits contextSizeTokens field', async () => {
    const ctx = makeCtx({
      agg: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.001,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      getContextSizeTokens: () => undefined,
    })

    await wrapTurnExecution(ctx, async () => {})

    const summary = appendTurnSummarySpy.mock.calls[0]![0] as { contextSizeTokens?: number }
    expect('contextSizeTokens' in summary).toBe(false)
  })

  it('uses routerSession.routedModel over defaultModel when populated', async () => {
    const ctx = makeCtx({
      agg: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.001,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      routerSession: { routedModel: 'glm-4.7-flash', routedTo: 'casual' },
      defaultModel: 'glm-4.6',
    })

    await wrapTurnExecution(ctx, async () => {})

    const summary = appendTurnSummarySpy.mock.calls[0]![0] as { model: string }
    expect(summary.model).toBe('glm-4.7-flash')
  })

  it('falls back to defaultModel when routerSession is empty', async () => {
    const ctx = makeCtx({
      agg: {
        inputTokens: 500,
        outputTokens: 200,
        costUsd: 0.001,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      defaultModel: 'glm-4.6',
    })

    await wrapTurnExecution(ctx, async () => {})

    const summary = appendTurnSummarySpy.mock.calls[0]![0] as { model: string }
    expect(summary.model).toBe('glm-4.6')
  })
})
