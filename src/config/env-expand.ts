/**
 * Expand `${VAR}` and `$VAR` placeholders inside MCP server config values
 * (env entries, args, command, cwd) using `process.env`.
 *
 * Rationale: keep secrets out of `~/.telemachus/config.json`. The config
 * references environment variables; the shell (or a sourced .env file) owns
 * the actual values. Missing variables expand to the empty string — logged
 * once so the user notices, but never fails config load.
 *
 * Not a full shell expansion: no `${VAR:-default}`, no command substitution.
 * Just the common case.
 */

import type { McpServerConfig } from './types.js'

const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g

const missingWarned = new Set<string>()

function expandString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(PLACEHOLDER_RE, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    const resolved = env[name]
    if (resolved === undefined) {
      if (!missingWarned.has(name)) {
        missingWarned.add(name)
        process.stderr.write(`[mcp-config] warning: env var ${name} is not set — expanding to empty string\n`)
      }
      return ''
    }
    return resolved
  })
}

/**
 * Return a new McpServerConfig with all string fields env-expanded.
 * Non-string fields (booleans, numbers, trustTier, toolOverrides) are copied as-is.
 */
export function expandMcpServerEnv(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  const expanded: McpServerConfig = { ...cfg }

  expanded.command = expandString(cfg.command, env)

  if (cfg.args) {
    expanded.args = cfg.args.map((a) => expandString(a, env))
  }

  if (cfg.env) {
    const envOut: Record<string, string> = {}
    for (const [k, v] of Object.entries(cfg.env)) {
      envOut[k] = expandString(v, env)
    }
    expanded.env = envOut
  }

  if (cfg.cwd !== undefined) {
    expanded.cwd = expandString(cfg.cwd, env)
  }

  return expanded
}

/**
 * Clear the warned-variables set. Test helper.
 */
export function _resetEnvExpandWarnings(): void {
  missingWarned.clear()
}
