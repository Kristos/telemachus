/**
 * Phase 75 (TRAJ-01..05): Trajectory signal store and bias computation.
 *
 * Signal records written to ~/.telemachus/routing-signals/signals.jsonl
 * after every routed turn. Manual /model overrides write a manual_override
 * record. At startup, BiasCache reads recent history and computes per-
 * (transport, intent) override rates to nudge future routing.
 */
import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { IntentClass } from '../config/types.js'
import { log } from '../log/logger.js'

const SIGNALS_DIR = join(homedir(), '.telemachus', 'routing-signals')
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl')
/** Max records returned by readLastN (read window). */
const MAX_READ = 500
/** Override rate threshold above which bias activates. */
export const BIAS_THRESHOLD = 0.3
/** Default minimum history records per (transport, intent) before bias activates. */
export const DEFAULT_MIN_HISTORY = 20

export interface SignalRecord {
  ts: string
  transport: 'discord' | 'telegram'
  type: 'auto' | 'manual_override'
  intent?: IntentClass   // present on 'auto' signals
  model: string          // routed model (auto) or new model (manual_override)
  costUsd?: number       // present on 'auto' signals
  outputTokens?: number  // present on 'auto' signals
}

/** Ensure the signals directory exists (idempotent). */
async function ensureDir(): Promise<void> {
  await mkdir(SIGNALS_DIR, { recursive: true })
}

/**
 * TRAJ-01 / TRAJ-02: Append a signal record to signals.jsonl.
 * Fire-and-forget — never awaited in production paths.
 */
export async function appendSignal(record: SignalRecord): Promise<void> {
  try {
    await ensureDir()
    await appendFile(SIGNALS_FILE, JSON.stringify(record) + '\n', 'utf-8')
  } catch (err) {
    log('warn', { module: 'trajectory', err: err instanceof Error ? err.message : String(err) }, 'signal write failed')
  }
}

/**
 * Read the last N signal records from signals.jsonl.
 * Returns empty array if file does not exist.
 */
export async function readLastNSignals(n: number = MAX_READ): Promise<SignalRecord[]> {
  try {
    const text = await readFile(SIGNALS_FILE, 'utf-8')
    const lines = text.split('\n').filter((l) => l.trim())
    const slice = lines.slice(-n)
    return slice.map((line) => {
      try { return JSON.parse(line) as SignalRecord } catch { return null }
    }).filter((r): r is SignalRecord => r !== null)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// BiasCache — loaded at startup, immutable after compute()
// ---------------------------------------------------------------------------

/**
 * TRAJ-03/04/05: Computed bias factors per (transport, intent).
 * shouldUpgrade() returns true when the override rate for this
 * (transport, intent) pair meets the threshold AND enough history exists.
 */
export class BiasCache {
  private readonly factors = new Map<string, { overrideRate: number; count: number }>()

  /**
   * Compute bias from the provided signal records.
   * @param signals - raw signal records (most recent N)
   * @param minHistory - minimum auto-signal count before bias activates (TRAJ-05)
   */
  compute(signals: SignalRecord[], minHistory: number = DEFAULT_MIN_HISTORY): void {
    this.factors.clear()

    // Count auto signals per (transport, intent)
    const autoCounts = new Map<string, number>()
    // Count manual_override signals per transport
    const overrideCounts = new Map<string, number>()

    for (const s of signals) {
      if (s.type === 'auto' && s.intent) {
        const key = `${s.transport}:${s.intent}`
        autoCounts.set(key, (autoCounts.get(key) ?? 0) + 1)
      } else if (s.type === 'manual_override') {
        overrideCounts.set(s.transport, (overrideCounts.get(s.transport) ?? 0) + 1)
      }
    }

    // For each (transport, intent) with enough history, compute override rate
    for (const [key, count] of autoCounts) {
      if (count < minHistory) continue
      const transport = key.split(':')[0]
      // Total auto signals for this transport (denominator for override rate)
      const totalAutoForTransport = [...autoCounts.entries()]
        .filter(([k]) => k.startsWith(transport + ':'))
        .reduce((sum, [, c]) => sum + c, 0)
      const overrides = overrideCounts.get(transport) ?? 0
      const overrideRate = totalAutoForTransport > 0 ? overrides / totalAutoForTransport : 0
      this.factors.set(key, { overrideRate, count })
    }
  }

  /**
   * TRAJ-04/05: Returns true when bias suggests upgrading this (transport, intent)
   * from the simple slot to the complex slot.
   *
   * Only meaningful for 'casual' intent (the only intent that defaults to simple).
   * 'code', 'research', 'orchestration' already route to complex — upgrading them
   * is a no-op (no effect on routing).
   */
  shouldUpgrade(transport: string, intent: IntentClass): boolean {
    const factor = this.factors.get(`${transport}:${intent}`)
    if (!factor) return false
    return factor.overrideRate >= BIAS_THRESHOLD
  }

  /** Returns the raw factors map for testing/debugging. */
  snapshot(): ReadonlyMap<string, { overrideRate: number; count: number }> {
    return this.factors
  }
}

/**
 * TRAJ-03: Load and compute bias cache at startup.
 * Reads last MAX_READ signals, computes bias, returns ready BiasCache.
 * Returns an empty (no-op) BiasCache if the signal file does not exist.
 */
export async function loadBiasCache(minHistory: number = DEFAULT_MIN_HISTORY): Promise<BiasCache> {
  const signals = await readLastNSignals(MAX_READ)
  const cache = new BiasCache()
  cache.compute(signals, minHistory)
  return cache
}
