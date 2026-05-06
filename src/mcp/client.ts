import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { ToolRegistry } from '../tools/registry.js'
import type { Tool, ToolResult } from '../tools/types.js'
import type { ClaudeJsonConfig, ClaudeJsonMcpServer } from '../config/mcp-config.js'
import type { McpServerConfig } from '../config/types.js'
import type { McpServerStatus, McpLoadResult } from './types.js'
import type { TrustTier } from '../security/trust-tiers.js'
import { buildMcpInvocation } from './invocation.js'

const MCP_CONNECT_TIMEOUT_MS = 30000

interface MCPTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    [key: string]: unknown
  }
}

/**
 * Bridge MCP protocol tools into our Tool interface.
 * Exported for testability.
 */
export function bridgeMcpTools(
  serverName: string,
  client: Client,
  mcpTools: MCPTool[],
): Tool[] {
  return mcpTools.map(mcpTool => {
    const rawInputSchema: Record<string, unknown> = mcpTool.inputSchema

    const tool: Tool = {
      name: `mcp__${serverName}__${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      inputSchema: z.object({}).passthrough(),
      rawInputSchema,
      execute: async (args: unknown): Promise<ToolResult> => {
        try {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args as Record<string, unknown>,
          })
          const text = (result.content as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('\n')
          return { content: text, isError: result.isError === true }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          return { content: `MCP tool error: ${errMsg}`, isError: true }
        }
      },
    }
    return tool
  })
}

export interface ConnectAndBridgeResult {
  client: Client
  transport: StdioClientTransport
  toolNames: string[]
  mcpTools: MCPTool[]
}

/**
 * Connect to a single MCP server, list its tools, and bridge them into the registry.
 * Throws on any failure (D-09: fail-fast, no auto-retry).
 * Caller is responsible for cleanup / state tracking.
 */
export async function connectAndBridge(
  name: string,
  cfg: Pick<McpServerConfig, 'command' | 'args' | 'env' | 'cwd' | 'sandbox'>,
  resolvedTier: TrustTier,
  registry: ToolRegistry,
): Promise<ConnectAndBridgeResult> {
  // D-01: rewrite command+args through sandbox layer before handing to transport.
  const invocation = buildMcpInvocation({ cfg, resolvedTier })

  const transport = new StdioClientTransport({
    command: invocation.command,
    args: invocation.args,
    env: invocation.env,
    cwd: cfg.cwd,
    stderr: 'pipe',
  })

  // Drain stderr to prevent backpressure (RESEARCH risk #10).
  // Access lazily — transport.stderr is only defined after spawn.
  const drainStderr = () => {
    const s = (transport as unknown as { stderr?: { on: (ev: string, cb: (d: unknown) => void) => void } }).stderr
    if (s && typeof s.on === 'function') {
      s.on('data', () => {})
    }
  }

  const client = new Client({ name: 'telemachus', version: '0.1.0' })

  const connectPromise = client.connect(transport)
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`MCP server "${name}" connect timeout after ${MCP_CONNECT_TIMEOUT_MS}ms`)),
      MCP_CONNECT_TIMEOUT_MS,
    ),
  )

  await Promise.race([connectPromise, timeoutPromise])
  drainStderr()

  const { tools: mcpToolsRaw } = await client.listTools()
  const mcpTools = mcpToolsRaw as MCPTool[]
  const bridged = bridgeMcpTools(name, client, mcpTools)

  const toolNames: string[] = []
  for (const tool of bridged) {
    registry.register(tool)
    toolNames.push(tool.name)
  }

  return { client, transport, toolNames, mcpTools }
}

/**
 * Legacy eager loader. Retained temporarily for any callers still using the
 * ClaudeJsonConfig shape. Plan 18-02 wires McpManager at startup instead.
 * All errors are caught per-server; never throws.
 */
export async function loadMcpClients(
  registry: ToolRegistry,
  claudeJson: ClaudeJsonConfig,
): Promise<McpLoadResult> {
  const serverStatus = new Map<string, McpServerStatus>()
  const servers = Object.entries(claudeJson.mcpServers ?? {})

  if (servers.length === 0) {
    return { serverStatus, toolCount: 0 }
  }

  await Promise.allSettled(
    servers.map(async ([name, cfg]: [string, ClaudeJsonMcpServer]) => {
      try {
        await connectAndBridge(name, cfg, 'dangerous', registry)
        serverStatus.set(name, 'alive')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        serverStatus.set(name, msg.includes('timeout') ? 'timeout' : 'error')
      }
    }),
  )

  const toolCount = registry.getAll().filter(t => t.name.startsWith('mcp__')).length
  return { serverStatus, toolCount }
}
