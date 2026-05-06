import type { PermissionMode, PermissionDecision } from './types.js'
import { getTier } from '../security/trust-tiers.js'

// NOTE: this function is security — it decides whether a tool call proceeds
// without user consent. The permission prompt that ask mode triggers is UX —
// it helps the owner review before running. The sandbox (bash.ts) is the actual
// enforcement boundary for bash; this function just decides whether to ask.

function isValidMode(value: string): value is PermissionMode {
  return (
    value === 'yolo' ||
    value === 'ask' ||
    value === 'readonly' ||
    value === 'plan' ||
    value === 'agent'
  )
}

/**
 * Resolve effective permission mode from config, env, and CLI flag.
 * Priority: cliMode > envMode > configMode
 * Invalid values are silently ignored and the next lower priority is used.
 */
export function resolveMode(
  configMode: PermissionMode,
  envMode?: string,
  cliMode?: string,
): PermissionMode {
  if (cliMode !== undefined && isValidMode(cliMode)) {
    return cliMode
  }
  if (envMode !== undefined && isValidMode(envMode)) {
    return envMode
  }
  return configMode
}

/**
 * Extract a human-readable summary of the tool invocation for display in prompts.
 * Prepends [network] for bash calls with network: true (SEC-04 prep).
 */
export function extractCommandSummary(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown>

  if (toolName === 'bash' && typeof inp?.command === 'string') {
    const prefix = inp.network === true ? '[network] ' : ''
    return prefix + inp.command.slice(0, 80)
  }

  // Phase 20 decision 9: for cli:<name> tools, the loop pre-computes a clean
  // command summary ("gh pr list", first sub-command only) and stashes it on
  // the input object as __cliCommandSummary. We show THAT in the prompt, never
  // the full arg string. Strip the marker so the field can't collide.
  if (typeof inp?.__cliCommandSummary === 'string') {
    return inp.__cliCommandSummary.slice(0, 80)
  }

  if (
    (toolName === 'file_write' || toolName === 'file_edit') &&
    typeof inp?.file_path === 'string'
  ) {
    return inp.file_path
  }

  return JSON.stringify(input).slice(0, 80)
}

/**
 * Gate a tool call against the active permission mode using trust tiers.
 *
 * Enforcement matrix (per CONTEXT D-02/D-03):
 *   Tier      | yolo  | ask  | readonly | plan
 *   safe      | allow | allow| allow    | allow
 *   risky     | allow | ask  | deny     | deny
 *   dangerous | allow | ask  | deny     | deny
 *
 * Returns:
 *   - { action: 'allow' }            — tool may run immediately
 *   - { action: 'deny', reason }     — tool is blocked
 *   - { action: 'ask', toolName, command } — ask user before running (ask mode)
 */
export function checkPermission(
  mode: PermissionMode,
  toolName: string,
  input: unknown,
  tierOverride?: import('../security/trust-tiers.js').TrustTier,
): PermissionDecision {
  // Phase 20 decision 9: the loop resolves sub-command tiers for cli:* tools
  // before calling this function and passes them in directly, bypassing the
  // static getTier lookup for those calls.
  const tier = tierOverride ?? getTier(toolName)

  // safe tools always run (every mode)
  if (tier === 'safe') {
    return { action: 'allow' }
  }

  // plan mode denies everything non-safe
  if (mode === 'plan') {
    return {
      action: 'deny',
      reason: `Tool '${toolName}' is blocked in plan mode. Propose an implementation plan and wait for the user to switch out of plan mode.`,
    }
  }

  // yolo allows everything (sandbox bypass handled separately in bash.ts)
  if (mode === 'yolo') {
    return { action: 'allow' }
  }

  // Phase 22 (AGENT-01), decision 6: `agent` mode is functionally yolo —
  // headless runs have no human to prompt — but audit entries are tagged
  // differently via toolContext.mode so reviewers can tell runs apart.
  if (mode === 'agent') {
    return { action: 'allow' }
  }

  // readonly denies everything non-safe
  if (mode === 'readonly') {
    return {
      action: 'deny',
      reason: `Tool '${toolName}' is not permitted in readonly mode.`,
    }
  }

  // ask mode — prompt for risky + dangerous
  return {
    action: 'ask',
    toolName,
    command: extractCommandSummary(toolName, input),
  }
}
