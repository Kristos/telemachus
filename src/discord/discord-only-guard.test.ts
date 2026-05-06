/**
 * Phase 57 (STRIP-05): Platform guard for tool-result stripping.
 * Phase 59 (ROUTE-06): Platform guard for RouterProvider imports.
 *
 * stripToolResults and getTokenEstimate must NEVER be called from
 * the CLI or orchestration path. CLI entry points (src/index.ts,
 * src/agent-runner/*) and the orchestration engine never invoke them —
 * if they did, the Anthropic prompt-caching invariant (CLI cacheReadTokens
 * > 0 on second turn) would silently break.
 *
 * Allowed callers: src/discord/ and src/telegram/ — both are interactive
 * platform adapters that legitimately manage conversation compression.
 *
 * RouterProvider must ONLY be imported from the allowed files below. The
 * CLI path (src/index.ts, src/agent-runner/) must never touch RouterProvider —
 * ROUTE-06 enforces this statically so there is no runtime regression risk.
 *
 * This test fails loudly if any cross-file import or call leaks outside
 * the allowed set. Test files (*.test.ts) are exempt from both guards.
 * JSDoc comment lines (starting with * or //) are also exempt.
 */
import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import * as url from 'node:url'

// Resolve repo root relative to this test file's directory: src/discord/ → up 2 levels
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../')

describe('Platform stripping guard (STRIP-05)', () => {
  it('stripToolResults and getTokenEstimate are referenced only under src/discord/ or src/telegram/ in production source', () => {
    const result = spawnSync(
      'grep',
      ['-rn', '--include=*.ts', 'stripToolResults\\|getTokenEstimate', 'src/'],
      { encoding: 'utf8', cwd: repoRoot },
    )

    // grep returns exit code 1 if no matches found at all — also valid if Phase 57
    // didn't ship, but we assert below that at least the definitions exist.
    // Exit code 2 = real error (file not found, etc.)
    if ((result.status ?? 0) === 2) {
      throw new Error(`grep failed: ${result.stderr}`)
    }

    const lines = (result.stdout ?? '').split('\n').filter(l => l.trim() !== '')

    // Sanity: confirm we got matches — Phase 57 must have shipped these methods.
    expect(lines.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const line of lines) {
      // grep -rn output: "path/to/file.ts:42:matched content"
      const firstColon = line.indexOf(':')
      if (firstColon === -1) continue
      const secondColon = line.indexOf(':', firstColon + 1)
      if (secondColon === -1) continue

      const filePath = line.slice(0, firstColon)
      const content = line.slice(secondColon + 1).trimStart()

      // Allowed: test files (they reference both methods for coverage)
      if (filePath.endsWith('.test.ts')) continue

      // Allowed: definition site — the methods live here, references are intrinsic
      if (filePath === 'src/discord/conversation.ts') continue

      // Allowed: any production file under src/discord/ or src/telegram/
      if (filePath.startsWith('src/discord/')) continue
      if (filePath.startsWith('src/telegram/')) continue

      // Allowed: JSDoc / comment lines only — these are documentation, not call sites
      // Match lines starting with * (JSDoc block) or // (line comment)
      if (/^\s*\*/.test(content) || /^\s*\/\//.test(content)) continue

      offenders.push(line)
    }

    if (offenders.length > 0) {
      const message = [
        'Phase 57 STRIP-05 violation: stripToolResults / getTokenEstimate referenced from non-platform production source.',
        'CLI Anthropic prompt-caching path must remain unaffected.',
        'Offending lines:',
        ...offenders.map(o => '  ' + o),
      ].join('\n')
      throw new Error(message)
    }

    expect(offenders).toEqual([])
  })
})

describe('Platform RouterProvider guard (ROUTE-06)', () => {
  it('RouterProvider is imported only from allowed production files (not CLI, not agent-runner)', () => {
    const result = spawnSync(
      'grep',
      ['-rn', '--include=*.ts', 'RouterProvider', 'src/'],
      { encoding: 'utf8', cwd: repoRoot },
    )

    if ((result.status ?? 0) === 2) {
      throw new Error(`grep failed: ${result.stderr}`)
    }

    const lines = (result.stdout ?? '').split('\n').filter(l => l.trim() !== '')

    // Sanity: Phase 59 must have shipped RouterProvider
    expect(lines.length).toBeGreaterThan(0)

    // Allowed production files that may reference RouterProvider
    const allowed = new Set([
      'src/providers/router.ts',
      'src/providers/router.test.ts',
      'src/discord/index.ts',
      'src/discord/router-assembly.ts',
      'src/discord/router-assembly.test.ts',
      'src/telegram/index.ts',
    ])

    const offenders: string[] = []
    for (const line of lines) {
      const firstColon = line.indexOf(':')
      if (firstColon === -1) continue
      const secondColon = line.indexOf(':', firstColon + 1)
      if (secondColon === -1) continue

      const filePath = line.slice(0, firstColon)
      const content = line.slice(secondColon + 1).trimStart()

      // Allowed: any test file
      if (filePath.endsWith('.test.ts')) continue
      // Allowed: explicit allow-list
      if (allowed.has(filePath)) continue
      // Allowed: JSDoc / comment lines
      if (/^\s*\*/.test(content) || /^\s*\/\//.test(content)) continue

      offenders.push(line)
    }

    if (offenders.length > 0) {
      const message = [
        'Phase 59 ROUTE-06 violation: RouterProvider imported/referenced from disallowed production source.',
        'Allowed: src/providers/router.ts, src/discord/router-assembly.ts, src/discord/index.ts, src/telegram/index.ts, *.test.ts files.',
        'Offending lines:',
        ...offenders.map(o => '  ' + o),
      ].join('\n')
      throw new Error(message)
    }

    expect(offenders).toEqual([])
  })
})
