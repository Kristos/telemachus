import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { getPlatformSandbox } from '../tools/sandbox/index.js'
import type { SandboxOptions } from '../tools/sandbox/macos.js'
import type { McpServerConfig } from '../config/types.js'
import type { TrustTier } from '../security/trust-tiers.js'
import type { PlatformSandbox } from '../tools/sandbox/index.js'

// NOTE: this is the Phase 25 equivalent of buildBashInvocation (Phase 17).
// It is a pure function — no Bun.spawn, no side effects, no filesystem access
// except path resolution. The actual StdioClientTransport construction happens
// in plan 25-03 wiring. This function is exhaustively unit-tested against the
// full trust-tier × network × platform decision matrix (SEC-06, SEC-07).
//
// Trust-tier → network mapping (D-04, D-05):
//   dangerous → network always false (user config silently overridden)
//   risky     → network always false (user config silently overridden)
//   safe      → network false by default; true only if sandbox.network === true
//
// extraPaths flow: resolved here, wired into SandboxOptions in Task 3.

export interface BuildMcpInvocationResult {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface BuildMcpInvocationInput {
  cfg: Pick<McpServerConfig, 'command' | 'args' | 'env' | 'cwd' | 'sandbox'>
  resolvedTier: TrustTier
  /** Injectable platform sandbox for testability; defaults to getPlatformSandbox(). */
  platformSandbox?: PlatformSandbox
  /** Injectable stderr writer for testability; defaults to process.stderr.write. */
  stderrWrite?: (msg: string) => void
  /** Injectable realpath for testability; defaults to realpathSync. */
  realpath?: (p: string) => string
}

export function buildMcpInvocation(input: BuildMcpInvocationInput): BuildMcpInvocationResult {
  const { cfg, resolvedTier } = input
  const sandbox = input.platformSandbox ?? getPlatformSandbox()
  const write = input.stderrWrite ?? ((m: string) => { process.stderr.write(m) })
  const rp = input.realpath ?? realpathSync

  // Network: only 'safe' tier may opt in via explicit sandbox.network: true (D-04, D-05)
  const networkRequested = cfg.sandbox?.network === true
  const network = resolvedTier === 'safe' && networkRequested

  // Resolve extra paths: ~ expansion + realpath; drop unresolvable with stderr warning (D-08)
  // NOTE: extraPaths wiring into SandboxOptions is done in Task 3 (extending SandboxOptions +
  // buildProfile). Here we resolve/validate the paths — the resolution logic is tested in
  // the decision matrix but the SBPL injection is deferred.
  const extraPaths: string[] = []
  for (const raw of cfg.sandbox?.paths ?? []) {
    const expanded = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw
    try {
      extraPaths.push(rp(expanded))
    } catch {
      write(`[mcp] sandbox.paths: dropped unresolvable entry "${raw}"\n`)
    }
  }

  // Resolve cwd (default to process.cwd()) — realpath it to match kernel view (Phase 17 pattern)
  const cwdRaw = cfg.cwd ?? process.cwd()
  let cwd: string
  try { cwd = rp(cwdRaw) } catch { cwd = cwdRaw }

  const opts: SandboxOptions = {
    network,
    cwd,
    tmpdir: tmpdir(),
    extraPaths: extraPaths.length > 0 ? extraPaths : undefined,
  }

  // On non-darwin, noop sandbox returns argv unchanged (D-03)
  const argv = sandbox.wrap(cfg.command, cfg.args ?? [], opts)

  return {
    command: argv[0]!,
    args: argv.slice(1),
    env: cfg.env,
  }
}
