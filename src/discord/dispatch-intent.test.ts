import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KEYWORD_PATTERNS,
  matchKeywordPattern,
  computeComplexitySignals,
  isAtBudgetThreshold,
  maybeAutoDispatch,
} from './dispatch-intent.js'
import type { DispatchResult, KeywordPattern } from './dispatch-intent.js'
import { DiscordTokenBudget } from './token-budget.js'
import * as state from './auto-dispatch-state.js'
import type { DiscordConfig } from './config.js'
import * as auditModule from '../security/audit.js'

// ============================================================================
// Phase 60-01 foundation tests (types + KEYWORD_PATTERNS) — preserved from 60-01
// ============================================================================

describe('dispatch-intent KEYWORD_PATTERNS (Phase 60 foundation)', () => {
  test('KEYWORD_PATTERNS length is exactly 18', () => {
    expect(KEYWORD_PATTERNS.length).toBe(18)
  })

  test('every pattern has id: string and re: RegExp shape', () => {
    for (const p of KEYWORD_PATTERNS) {
      expect(typeof p.id).toBe('string')
      expect(p.id.length).toBeGreaterThan(0)
      expect(p.re).toBeInstanceOf(RegExp)
    }
  })

  test('every pattern regex is case-insensitive (has /i flag)', () => {
    const allCaseInsensitive = KEYWORD_PATTERNS.every(p => p.re.flags.includes('i'))
    expect(allCaseInsensitive).toBe(true)
  })

  test('all 18 pattern ids are distinct', () => {
    const ids = KEYWORD_PATTERNS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('DispatchResult discriminated union narrows correctly', () => {
    const positive: DispatchResult = { dispatch: true, signalsMatched: ['build-a'] }
    const negative: DispatchResult = { dispatch: false, reason: 'disabled' }

    if (positive.dispatch === true) {
      expect(positive.signalsMatched).toEqual(['build-a'])
    } else {
      throw new Error('positive branch not narrowed')
    }

    if (negative.dispatch === false) {
      expect(negative.reason).toBe('disabled')
    } else {
      throw new Error('negative branch not narrowed')
    }
  })

  test('KeywordPattern type export is importable (compile-time check)', () => {
    const custom: KeywordPattern = { id: 'test', re: /test/i }
    expect(custom.id).toBe('test')
  })
})

// ============================================================================
// Phase 60-03 Task 1: KEYWORD_PATTERNS coverage — one positive test per pattern
// ============================================================================

/**
 * Canonical positive example per pattern (per D-02).
 * Keyed by the pattern id for traceability. Every KEYWORD_PATTERNS entry
 * must have exactly one canonical example that causes it to match via
 * matchKeywordPattern and produces its own id (first-match-wins ordering).
 */
const CANONICAL_POSITIVE_EXAMPLES: Record<string, string> = {
  'build-a': 'Please build a landing page for the new product',
  'set-up': 'Can you set up a new postgres database',
  'create-a-new': 'Create a new component for the nav',
  'make-me-a': 'make me a really clean dashboard',
  'migrate-from': 'Migrate from mysql to postgres',
  'refactor-into': 'Refactor the auth module into separate files',
  'convert-to': 'Convert the CommonJS code to ESM',
  'port-to': 'Port the rust core to typescript',
  'scaffold': 'scaffold the entire project structure',
  'bootstrap': 'bootstrap the app',
  'initialize-a': 'initialize a fresh git repo',
  'spin-up-a': 'spin up a test server',
  'implement-a': 'implement a caching layer',
  'write-me-a': 'write me a test harness',
  'generate-a': 'generate a migration file',
  'add-support-for': 'add support for OAuth',
  'integrate-with': 'integrate Stripe with our checkout flow',
  'implement-support-for': 'implement support for refresh tokens',
}

describe('KEYWORD_PATTERNS coverage (Phase 60 Task 1, DISPATCH-02)', () => {
  for (const pattern of KEYWORD_PATTERNS) {
    test(`pattern ${pattern.id} matches canonical example`, () => {
      const example = CANONICAL_POSITIVE_EXAMPLES[pattern.id]
      expect(example).toBeDefined()
      expect(example).not.toBe('')
      // The pattern itself must match the canonical example
      expect(pattern.re.test(example!)).toBe(true)
    })
  }

  test('every pattern id has a canonical example in CANONICAL_POSITIVE_EXAMPLES', () => {
    // Guards against silently missing a pattern when the seed list changes
    for (const p of KEYWORD_PATTERNS) {
      expect(CANONICAL_POSITIVE_EXAMPLES[p.id]).toBeDefined()
    }
  })
})

// ============================================================================
// Phase 60-03 Task 1: matchKeywordPattern
// ============================================================================

describe('matchKeywordPattern (Phase 60 Task 1, DISPATCH-02)', () => {
  test('returns matching id for a canonical build-a example', () => {
    const result = matchKeywordPattern('Please build a landing page')
    expect(result).not.toBeNull()
    expect(result?.id).toBe('build-a')
  })

  test('returns null for a trivial non-keyword message', () => {
    const result = matchKeywordPattern('Fix the typo and update the comment')
    expect(result).toBeNull()
  })

  test('is case-insensitive via pattern /i flag', () => {
    const result = matchKeywordPattern('PLEASE BUILD A landing page')
    expect(result?.id).toBe('build-a')
  })

  test('first-match-wins: "build a scaffold" matches build-a before scaffold', () => {
    // build-a appears first in KEYWORD_PATTERNS; scaffold appears later.
    // matchKeywordPattern iterates sequentially and returns the first hit.
    const result = matchKeywordPattern('build a scaffold for the app')
    expect(result?.id).toBe('build-a')
  })

  test('returns null for an empty string', () => {
    expect(matchKeywordPattern('')).toBeNull()
  })
})

// ============================================================================
// Phase 60-03 Task 1: computeComplexitySignals — 4 independent signals
// ============================================================================

describe('computeComplexitySignals (Phase 60 Task 1, DISPATCH-03)', () => {
  test('taskBoundaries true when numbered list has >=2 items', () => {
    const content = '1. Foo\n2. Bar'
    const signals = computeComplexitySignals(content)
    expect(signals.taskBoundaries).toBe(true)
  })

  test('taskBoundaries false when numbered list has only 1 item', () => {
    const content = '1. Foo alone'
    const signals = computeComplexitySignals(content)
    expect(signals.taskBoundaries).toBe(false)
  })

  test('taskBoundaries true when bullet list has >=2 items', () => {
    const content = '- foo\n- bar'
    const signals = computeComplexitySignals(content)
    expect(signals.taskBoundaries).toBe(true)
  })

  test('taskBoundaries false when bullet list has only 1 item', () => {
    const content = '- foo alone'
    const signals = computeComplexitySignals(content)
    expect(signals.taskBoundaries).toBe(false)
  })

  test('distinctFilenames true with two filename matches', () => {
    const content = 'please edit src/foo.ts and src/bar.ts'
    const signals = computeComplexitySignals(content)
    expect(signals.distinctFilenames).toBe(true)
  })

  test('distinctFilenames false with only one filename', () => {
    const content = 'please edit src/foo.ts'
    const signals = computeComplexitySignals(content)
    expect(signals.distinctFilenames).toBe(false)
  })

  test('dependencyLanguage true for "after X, then Y" phrasing', () => {
    const content = 'after the API is done, then add the UI'
    const signals = computeComplexitySignals(content)
    expect(signals.dependencyLanguage).toBe(true)
  })

  test('dependencyLanguage true for "first X then Y" phrasing', () => {
    const content = 'first do the setup then do the tests'
    const signals = computeComplexitySignals(content)
    expect(signals.dependencyLanguage).toBe(true)
  })

  test('wordCountOver200 true for 201-word content', () => {
    // Build 201 words: "word word word ..."
    const content = Array.from({ length: 201 }, (_, i) => `word${i}`).join(' ')
    const signals = computeComplexitySignals(content)
    expect(signals.wordCountOver200).toBe(true)
  })

  test('wordCountOver200 false for exactly 200-word content', () => {
    const content = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const signals = computeComplexitySignals(content)
    expect(signals.wordCountOver200).toBe(false)
  })

  test('all 4 signals false on trivial message', () => {
    const signals = computeComplexitySignals('Fix the typo')
    expect(signals.taskBoundaries).toBe(false)
    expect(signals.distinctFilenames).toBe(false)
    expect(signals.dependencyLanguage).toBe(false)
    expect(signals.wordCountOver200).toBe(false)
  })
})

// ============================================================================
// Phase 60-03 Task 2: isAtBudgetThreshold (pure helper using getState, NOT checkBudget)
// ============================================================================

describe('isAtBudgetThreshold (Phase 60 Task 2, DISPATCH-04 / Q4 correction)', () => {
  test('returns true at exact 95% threshold (95/100)', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 100 })
    budget.recordUsage('u1', 95)
    expect(isAtBudgetThreshold(budget, 'u1', 0.95)).toBe(true)
  })

  test('returns false below threshold (94/100)', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 100 })
    budget.recordUsage('u1', 94)
    expect(isAtBudgetThreshold(budget, 'u1', 0.95)).toBe(false)
  })

  test('returns true at 100% (100/100)', () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 100 })
    budget.recordUsage('u1', 100)
    expect(isAtBudgetThreshold(budget, 'u1', 0.95)).toBe(true)
  })
})

// ============================================================================
// Phase 60-03 Task 2: maybeAutoDispatch (integration of all pure helpers + audit)
// ============================================================================

/**
 * Test harness: redirect process.env.HOME to a tmp dir so appendAuditEntry
 * writes to a disposable JSONL file instead of polluting ~/.telemachus.
 */
let TEST_HOME: string
let ORIGINAL_HOME: string | undefined
function setupTempHome(): string {
  ORIGINAL_HOME = process.env.HOME
  TEST_HOME = mkdtempSync(join(tmpdir(), 'phase60-03-'))
  process.env.HOME = TEST_HOME
  // Pre-create the directories the budget tracker and audit writer use so
  // fire-and-forget appendBudgetEntry / appendAuditEntry don't print noisy
  // ENOENT warnings during tests. These calls are best-effort by design;
  // the warnings are harmless but clutter test output.
  mkdirSync(join(TEST_HOME, '.telemachus', 'discord-budget'), { recursive: true })
  mkdirSync(join(TEST_HOME, '.telemachus', 'audit'), { recursive: true })
  return TEST_HOME
}
function teardownTempHome(): void {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = ORIGINAL_HOME
  }
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true })
}

/**
 * Read every audit JSONL line under the test HOME and parse them.
 * Returns an empty array when no audit file exists yet (many tests never
 * touch audit — e.g., reason='disabled' short-circuit).
 */
function readAuditRows(): Record<string, unknown>[] {
  const auditDir = join(TEST_HOME, '.telemachus', 'audit')
  if (!existsSync(auditDir)) return []
  const today = new Date().toISOString().slice(0, 10)
  const path = join(auditDir, `${today}.jsonl`)
  if (!existsSync(path)) return []
  const contents = readFileSync(path, 'utf8')
  return contents
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Wait for any pending fire-and-forget audit writes to complete. */
async function flushAudit(): Promise<void> {
  // appendAuditEntry is async but called without await in maybeAutoDispatch
  // (fire-and-forget). 10ms isn't enough on slower runners (CI Linux), so
  // poll the audit file for up to 500ms instead of a fixed sleep.
  const auditDir = join(TEST_HOME, '.telemachus', 'audit')
  const today = new Date().toISOString().slice(0, 10)
  const path = join(auditDir, `${today}.jsonl`)
  for (let i = 0; i < 50; i++) {
    if (existsSync(path)) {
      // Give the write itself ~10ms to settle; appendFile may have created the
      // file before the line was flushed.
      await new Promise(resolve => setTimeout(resolve, 10))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function makeEnabledConfig(cancellationWindowMs = 10000): DiscordConfig {
  return {
    tokenEnv: 'TOKEN',
    allowedUsers: ['u1'],
    autoDispatch: { enabled: true, cancellationWindowMs },
  }
}
function makeDisabledConfig(): DiscordConfig {
  return {
    tokenEnv: 'TOKEN',
    allowedUsers: ['u1'],
    autoDispatch: { enabled: false },
  }
}
function makeMissingConfig(): DiscordConfig {
  return {
    tokenEnv: 'TOKEN',
    allowedUsers: ['u1'],
  }
}

describe('maybeAutoDispatch (Phase 60 Task 2, DISPATCH-04/08/09)', () => {
  beforeEach(() => {
    state.__resetForTests()
    setupTempHome()
  })
  afterEach(() => {
    state.__resetForTests()
    teardownTempHome()
  })

  test('Test 28: autoDispatch.enabled=false short-circuits to disabled (no audit)', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const result = await maybeAutoDispatch({
      content: 'build a landing page that does many things',
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeDisabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'disabled' })
    await flushAudit()
    expect(readAuditRows()).toHaveLength(0)
  })

  test('Test 28b: autoDispatch block entirely missing also returns disabled', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const result = await maybeAutoDispatch({
      content: 'build a scaffold',
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeMissingConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'disabled' })
  })

  test('Test 29: no keyword returns no_keyword (no audit — fast path)', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const result = await maybeAutoDispatch({
      content: 'Fix the typo',
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'no_keyword' })
    await flushAudit()
    expect(readAuditRows()).toHaveLength(0)
  })

  test('Test 30: keyword + 0 complexity signals → complexity_gate + audit', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const result = await maybeAutoDispatch({
      content: 'build a thing',
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'complexity_gate' })
    await flushAudit()
    const rows = readAuditRows()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const refused = rows.find(r => r.kind === 'auto_dispatch_refused')
    expect(refused).toBeDefined()
    expect(refused?.dispatchReason).toBe('complexity_gate')
    expect(refused?.channelId).toBe('ch1')
    expect(refused?.userId).toBe('u1')
  })

  test('Test 31: keyword + 1 signal → complexity_gate', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    // Only dependencyLanguage fires ("after X, then Y"); no list, no filenames, <200 words.
    const content = 'build a thing: after the API is done, then add the UI'
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'complexity_gate' })
    await flushAudit()
    const refused = readAuditRows().find(r => r.kind === 'auto_dispatch_refused')
    expect(refused).toBeDefined()
    // signalsMatched optional but when present should include which complexity
    // signals did fire — useful diagnostic when gate is narrowly missed.
    if (Array.isArray(refused?.signalsMatched)) {
      expect(refused?.signalsMatched).toContain('dependency-language')
    }
  })

  test('Test 32: keyword + 2 signals → dispatch:true + auto_dispatched audit', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    // build-a (keyword) + taskBoundaries (numbered list ≥2) + distinctFilenames (2 files)
    const content = `build a new service
1. Create src/foo.ts with the core logic
2. Wire src/bar.ts to import it`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
      turnId: 'turn-abc',
    })
    expect(result.dispatch).toBe(true)
    if (result.dispatch === true) {
      expect(result.signalsMatched).toContain('build-a')
      expect(result.signalsMatched.length).toBeGreaterThanOrEqual(3) // keyword + ≥2 signals
    }
    await flushAudit()
    const dispatched = readAuditRows().find(r => r.kind === 'auto_dispatched')
    expect(dispatched).toBeDefined()
    expect(dispatched?.turnId).toBe('turn-abc')
    expect(dispatched?.channelId).toBe('ch1')
    expect(dispatched?.userId).toBe('u1')
    expect(typeof dispatched?.contentSnippet).toBe('string')
    expect((dispatched?.contentSnippet as string).length).toBeLessThanOrEqual(50)
    expect(Array.isArray(dispatched?.signalsMatched)).toBe(true)
  })

  test('Test 33: ROADMAP SC#1 regression — "Fix the typo and update the comment" does NOT dispatch', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const result = await maybeAutoDispatch({
      content: 'Fix the typo and update the comment',
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result.dispatch).toBe(false)
    if (result.dispatch === false) {
      // "fix" is not in the keyword list → fast-path no_keyword. If a future
      // seed-list revision adds a "fix" keyword, complexity_gate is also
      // acceptable — both refuse dispatch.
      expect(['no_keyword', 'complexity_gate']).toContain(result.reason)
    }
  })

  test('Test 34: budget at 95% threshold → budget_exceeded + audit', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1000 })
    budget.recordUsage('u1', 950) // exactly 95%
    const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'budget_exceeded' })
    await flushAudit()
    const refused = readAuditRows().find(r => r.kind === 'auto_dispatch_refused')
    expect(refused).toBeDefined()
    expect(refused?.dispatchReason).toBe('budget_exceeded')
  })

  test('Test 35: budget at 94% does NOT short-circuit on budget (proceeds)', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1000 })
    budget.recordUsage('u1', 940) // 94%
    const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    // Should pass budget and proceed to dispatch (2 signals + keyword)
    expect(result.dispatch).toBe(true)
  })

  test('Test 36: cooldown active → cooldown + audit', async () => {
    state.registerOrchestrationComplete('ch1')
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'cooldown' })
    await flushAudit()
    const refused = readAuditRows().find(r => r.kind === 'auto_dispatch_refused')
    expect(refused).toBeDefined()
    expect(refused?.dispatchReason).toBe('cooldown')
  })

  test('Test 37: pending dispatch on same channel → pending + audit', async () => {
    // Seed a pending dispatch on the channel without awaiting resolution
    state.setPendingAutoDispatch('ch1', () => {}, 60_000)
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeEnabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'pending' })
    await flushAudit()
    const refused = readAuditRows().find(r => r.kind === 'auto_dispatch_refused')
    expect(refused).toBeDefined()
    expect(refused?.dispatchReason).toBe('pending')
  })

  test('Test 38: auto_dispatched payload shape — required fields + snippet length', async () => {
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const longContent = 'build a new service with many features: ' + 'x'.repeat(200) +
      `\n1. Create src/foo.ts\n2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content: longContent,
      channelId: 'ch-shape',
      userId: 'u-shape',
      budget,
      config: makeEnabledConfig(),
      turnId: 't-1',
      sessionId: 'sess-1',
      platform: 'darwin',
    })
    expect(result.dispatch).toBe(true)
    await flushAudit()
    const dispatched = readAuditRows().find(r => r.kind === 'auto_dispatched')
    expect(dispatched).toBeDefined()
    expect(dispatched?.kind).toBe('auto_dispatched')
    expect(typeof dispatched?.ts).toBe('string')
    expect(dispatched?.sessionId).toBe('sess-1')
    expect(dispatched?.platform).toBe('darwin')
    expect(dispatched?.turnId).toBe('t-1')
    expect(dispatched?.channelId).toBe('ch-shape')
    expect(dispatched?.userId).toBe('u-shape')
    expect(dispatched?.contentSnippet).toBe(longContent.slice(0, 50))
    expect((dispatched?.contentSnippet as string).length).toBe(50)
    expect(Array.isArray(dispatched?.signalsMatched)).toBe(true)
  })

  test('Test 39: audit failure does not crash dispatch (best-effort)', async () => {
    // Force appendAuditEntry to reject. maybeAutoDispatch must still return
    // the correct DispatchResult without throwing.
    const spy = spyOn(auditModule, 'appendAuditEntry').mockImplementation(async () => {
      throw new Error('simulated audit failure')
    })
    try {
      const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
      const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
      const result = await maybeAutoDispatch({
        content,
        channelId: 'ch1',
        userId: 'u1',
        budget,
        config: makeEnabledConfig(),
      })
      expect(result.dispatch).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test('Test 40: maybeAutoDispatch check order — disabled short-circuits before keyword', async () => {
    // Regression: disabled + would-dispatch content still returns disabled.
    // Confirms check order: disabled first, never computes keyword/complexity/budget.
    const budget = new DiscordTokenBudget({ dailyTokens: 1_000_000 })
    const content = `build a new service
1. Create src/foo.ts
2. Wire src/bar.ts`
    const result = await maybeAutoDispatch({
      content,
      channelId: 'ch1',
      userId: 'u1',
      budget,
      config: makeDisabledConfig(),
    })
    expect(result).toEqual({ dispatch: false, reason: 'disabled' })
  })
})
