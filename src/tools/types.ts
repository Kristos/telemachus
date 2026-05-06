import { z } from 'zod'
import type { SubagentParent } from '../agent/subagent.js'
import type { PermissionMode } from '../permissions/types.js'

export interface ToolResult {
  content: string
  isError: boolean
}

export interface ToolContext {
  cwd: string
  toolTimeoutMs: number
  askUser: (question: string, options: string[]) => Promise<string>
  checkPermission?: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>
  // Populated by App when constructing context. Required by the `task` built-in tool
  // to spawn a subagent loop. Existing tools ignore this field.
  subagentParent?: SubagentParent
  // Subagent lifecycle hooks — App wires these so the task tool can drive a UI indicator.
  // Both optional; existing tools ignore them. The task tool calls onSubagentStart() before
  // invoking runSubagent() and onSubagentEnd() in a finally block so the indicator always clears.
  onSubagentStart?: () => void
  onSubagentEnd?: () => void
  // Worktree tool uses these to mutate the session's live cwd.
  cwdRef?: { get(): string; set(next: string): void }
  originalCwd?: string
  // Phase 17: security/audit plumbing — optional so unrelated tools ignore them.
  sessionId?: string            // consumed by audit log in agent/loop.ts
  mode?: PermissionMode         // active permission mode, recorded in audit
  sessionTmpdir?: string        // /private/tmp/kc-<sessionId>, used by bash sandbox
  sandboxAvailable?: boolean    // result of detectSandboxExec() probe at startup
  // Phase 31 (SEC-13): Discord source attribution — propagated to audit entries.
  // Set by the Discord bot's runner adapter; absent in interactive/agent-runner contexts.
  source?: 'discord'
  discordUserId?: string
  discordChannelId?: string
}

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  isServerTool?: boolean  // true for web_search — provider handles execution
  rawInputSchema?: Record<string, unknown>  // for MCP tools; overrides Zod conversion in toAPISchema
  execute(args: unknown, context: ToolContext): Promise<ToolResult>
}
