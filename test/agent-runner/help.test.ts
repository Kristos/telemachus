/**
 * Phase 22-03 (AGENT-03): help text + runAgentSubcommand dispatcher.
 *
 * These tests exercise the CLI-facing branches of `runAgentSubcommand`
 * WITHOUT running a real job. We stub `process.stderr.write` and
 * `process.exit` to capture output + exit code per branch.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { printAgentHelp } from '../../src/agent-runner/help.js'
import { runAgentSubcommand } from '../../src/agent-runner/index.js'

// ————— stderr + exit capture harness —————

class ExitError extends Error {
  code: number
  constructor(code: number) {
    super(`process.exit(${code})`)
    this.code = code
  }
}

let stderrBuf: string
let origStderrWrite: typeof process.stderr.write
let origExit: typeof process.exit
let origHome: string | undefined
let tmpHome: string

beforeEach(() => {
  stderrBuf = ''
  origStderrWrite = process.stderr.write.bind(process.stderr)
  // @ts-ignore — monkey-patch for capture
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  origExit = process.exit
  // @ts-ignore — replace with throwing stub
  process.exit = (code?: number): never => {
    throw new ExitError(code ?? 0)
  }

  // Temp HOME with an empty ~/.telemachus/config.json so loadConfig finds
  // a config with no agents defined — the "unknown job" branch can fire.
  origHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-help-'))
  fs.mkdirSync(path.join(tmpHome, '.telemachus'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, '.telemachus', 'config.json'),
    JSON.stringify({ agents: {} }),
  )
  process.env.HOME = tmpHome
})

afterEach(async () => {
  process.stderr.write = origStderrWrite
  process.exit = origExit
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
})

async function runDispatch(argv: string[]): Promise<number> {
  try {
    await runAgentSubcommand(argv)
    return 0 // shouldn't reach — dispatcher always exits
  } catch (err) {
    if (err instanceof ExitError) return err.code
    throw err
  }
}

// ————— printAgentHelp —————

describe('printAgentHelp', () => {
  test('writes help block to stderr with expected sections', () => {
    printAgentHelp()
    expect(stderrBuf).toContain('tm agent')
    expect(stderrBuf).toContain('run <name>')
    expect(stderrBuf).toContain('status')
    expect(stderrBuf).toContain('install <name>')
    expect(stderrBuf).toContain('uninstall <name>')
    expect(stderrBuf).toContain('list')
    expect(stderrBuf).toContain('--help')
    expect(stderrBuf).toContain('agents.<name>')
  })
})

// ————— runAgentSubcommand dispatcher branches —————

describe('runAgentSubcommand dispatch', () => {
  test('empty argv → prints help, exit 0', async () => {
    const code = await runDispatch([])
    expect(code).toBe(0)
    expect(stderrBuf).toContain('tm agent')
    expect(stderrBuf).toContain('run <name>')
  })

  test('--help → prints help, exit 0', async () => {
    const code = await runDispatch(['--help'])
    expect(code).toBe(0)
    expect(stderrBuf).toContain('tm agent')
  })

  test('-h → prints help, exit 0', async () => {
    const code = await runDispatch(['-h'])
    expect(code).toBe(0)
    expect(stderrBuf).toContain('tm agent')
  })

  test('run without name → error + help, exit 1', async () => {
    const code = await runDispatch(['run'])
    expect(code).toBe(1)
    expect(stderrBuf).toContain('Error:')
    expect(stderrBuf).toContain('requires a job name')
    expect(stderrBuf).toContain('tm agent') // help also printed
  })

  test('run <unknown> with empty agents → helpful error, exit 1', async () => {
    const code = await runDispatch(['run', 'nonexistent-job'])
    expect(code).toBe(1)
    expect(stderrBuf).toContain('Error:')
    expect(stderrBuf).toContain("nonexistent-job")
    expect(stderrBuf).toContain('config.agents')
  })

  test('status → real handler, exit 0 even when no runs exist', async () => {
    // Phase 23 implemented status. With no agent runs in the temp HOME, the
    // command should print the empty-state message and exit 0.
    const code = await runDispatch(['status'])
    expect(code).toBe(0)
    // The empty-state message goes to stdout in the real impl; we don't
    // assert content here, just the exit code, since stdoutBuf wiring varies.
  })

  test('install without name → error + help, exit 1', async () => {
    // Phase 24-02 implemented install; calling it without a job name is now
    // a usage error (not "not implemented yet").
    const code = await runDispatch(['install'])
    expect(code).toBe(1)
    expect(stderrBuf).toContain('Error:')
    expect(stderrBuf).toContain('requires a job name')
    expect(stderrBuf).toContain('tm agent') // help also printed
  })

  test('list → real handler runs (exit 0 or 2 depending on config)', async () => {
    // Phase 24-02 implemented list. Without a config.json in the test HOME,
    // loadConfig will throw and the branch exits 2. What we assert is that
    // we are no longer in the "not implemented yet" state.
    const code = await runDispatch(['list'])
    expect(stderrBuf).not.toContain('not implemented yet')
    expect([0, 2]).toContain(code)
  })

  test('bogus subcommand → unknown subcommand + help, exit 1', async () => {
    const code = await runDispatch(['bogus'])
    expect(code).toBe(1)
    expect(stderrBuf).toContain("unknown subcommand")
    expect(stderrBuf).toContain("'bogus'")
    expect(stderrBuf).toContain('tm agent') // help also printed
  })
})
