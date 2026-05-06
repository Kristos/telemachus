/**
 * SAND-03 invariant regression test (Phase 62, BACKLOG 999.15).
 *
 * Asserts zero reads of `process.env.HOME` / `process.env.HOMEPATH` /
 * `process.env.USERPROFILE` and zero direct `process.cwd()` calls in
 * production tool code under src/tools/ (excluding `.test.ts`). Any
 * legitimate exception must carry a `SAND-03 exception` comment within
 * 3 lines above the violating line.
 *
 * Strategy: grep via ripgrep (via Bun.spawn) with a Node readdir fallback
 * for environments without rg. No mocks, no network, no env mutation.
 *
 * Origin: 2026-04-19 session-log review — 17× write_todos EROFS + 7×
 * file_write EROFS + 9× glob EBADF at CWD='/' went unnoticed for days.
 * 62-01 fixed write_todos; this test locks the invariant for the rest.
 */
import { describe, it, expect } from 'bun:test'
import { readdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '..', 'tools')
const EXCEPTION_WINDOW_LINES = 3

interface Hit {
  file: string
  line: number
  content: string
}

async function rgAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['rg', '--version'], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

async function grepViaRg(pattern: string): Promise<Hit[]> {
  const proc = Bun.spawn(
    ['rg', '-n', '--no-heading', '--glob', '!**/*.test.ts', pattern, TOOLS_DIR],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0 && out.trim() === '') return []
  return parseRgOutput(out)
}

function parseRgOutput(out: string): Hit[] {
  const hits: Hit[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    // rg format: path:lineNo:content
    const match = /^(.+?):(\d+):(.*)$/.exec(line)
    if (!match) continue
    hits.push({ file: match[1]!, line: Number(match[2]), content: match[3]! })
  }
  return hits
}

async function walkTsFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkTsFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
}

async function grepViaNode(regex: RegExp): Promise<Hit[]> {
  const files: string[] = []
  await walkTsFiles(TOOLS_DIR, files)
  const hits: Hit[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const lines = content.split('\n')
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        hits.push({ file, line: idx + 1, content: line })
      }
    })
  }
  return hits
}

async function grepMatches(pattern: string, regex: RegExp): Promise<Hit[]> {
  if (await rgAvailable()) return grepViaRg(pattern)
  return grepViaNode(regex)
}

/**
 * Returns true if the hit has a `SAND-03 exception` comment within the
 * EXCEPTION_WINDOW_LINES preceding source lines.
 */
async function isException(hit: Hit): Promise<boolean> {
  const content = await readFile(hit.file, 'utf8')
  const lines = content.split('\n')
  const start = Math.max(0, hit.line - 1 - EXCEPTION_WINDOW_LINES)
  const end = Math.max(0, hit.line - 1)
  for (let i = start; i < end; i++) {
    if (lines[i]?.includes('SAND-03 exception')) return true
  }
  return false
}

async function undocumentedHits(pattern: string, regex: RegExp): Promise<Hit[]> {
  const all = await grepMatches(pattern, regex)
  const filtered: Hit[] = []
  for (const hit of all) {
    if (!(await isException(hit))) filtered.push(hit)
  }
  return filtered
}

describe('SAND-03 invariant: no forbidden HOME/CWD reads in src/tools/ (Phase 62, 999.15)', () => {
  it('tools directory is reachable (smoke)', async () => {
    await access(TOOLS_DIR)
  })

  it('zero undocumented process.env.HOME reads in production tool code', async () => {
    const hits = await undocumentedHits(
      'process\\.env\\.HOME\\b',
      /process\.env\.HOME\b/,
    )
    if (hits.length > 0) {
      console.error('SAND-03 VIOLATION: undocumented process.env.HOME reads:')
      for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.content.trim()}`)
    }
    expect(hits).toHaveLength(0)
  })

  it('zero undocumented process.env.HOMEPATH reads in production tool code', async () => {
    const hits = await undocumentedHits(
      'process\\.env\\.HOMEPATH',
      /process\.env\.HOMEPATH/,
    )
    expect(hits).toHaveLength(0)
  })

  it('zero undocumented process.env.USERPROFILE reads in production tool code', async () => {
    const hits = await undocumentedHits(
      'process\\.env\\.USERPROFILE',
      /process\.env\.USERPROFILE/,
    )
    expect(hits).toHaveLength(0)
  })

  it('zero undocumented process.cwd() calls in production tool code', async () => {
    const hits = await undocumentedHits(
      'process\\.cwd\\(\\)',
      /process\.cwd\(\)/,
    )
    if (hits.length > 0) {
      console.error('SAND-03 VIOLATION: undocumented process.cwd() calls:')
      for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.content.trim()}`)
    }
    expect(hits).toHaveLength(0)
  })
})
