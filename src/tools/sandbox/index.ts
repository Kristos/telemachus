import * as macos from './macos.js'

// NOTE: this dispatcher is why we can keep bash.ts platform-agnostic. On macOS
// it hands back the real sandbox-exec wrapper. On Linux/Windows it hands back a
// no-op that passes the command through unchanged — the agent will emit a
// one-time warning (handled in src/index.ts startup) and the audit log will
// record sandbox: 'n/a' for those platforms. See CONTEXT SEC-05.

export type { SandboxOptions } from './macos.js'
import type { SandboxOptions } from './macos.js'

export interface PlatformSandbox {
  available: boolean
  wrap(shellCmd: string, shellArgs: string[], opts: SandboxOptions): string[]
  detect(): Promise<boolean>
}

const darwinSandbox: PlatformSandbox = {
  available: true,
  wrap(shellCmd, shellArgs, opts) {
    return macos.buildSandboxArgs(shellCmd, shellArgs, opts)
  },
  detect() {
    return macos.detectSandboxExec()
  },
}

const noopSandbox: PlatformSandbox = {
  available: false,
  wrap(shellCmd, shellArgs, _opts) {
    return [shellCmd, ...shellArgs]
  },
  async detect() {
    return false
  },
}

export function getPlatformSandbox(): PlatformSandbox {
  return process.platform === 'darwin' ? darwinSandbox : noopSandbox
}
