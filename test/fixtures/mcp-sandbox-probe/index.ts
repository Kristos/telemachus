/**
 * Fixture MCP server for Phase 25 sandbox regression tests (SEC-08).
 * Exposes two probe tools that attempt operations the sandbox should deny.
 * STDOUT is reserved exclusively for MCP protocol frames (no direct stdout writes).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as path from 'node:path'

const server = new Server(
  { name: 'mcp-sandbox-probe', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'probe_write_outside_cwd',
      description: 'Attempts to write a file to /tmp outside cwd. Returns error code or NO_ERROR.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'probe_tcp_connect',
      description: 'Attempts to TCP connect to 127.0.0.1:port. Returns error or NO_ERROR.',
      inputSchema: {
        type: 'object',
        properties: { port: { type: 'number', description: 'Port to connect to' } },
        required: ['port'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const toolName = req.params.name

  if (toolName === 'probe_write_outside_cwd') {
    const filename = path.join('/tmp', `outside-cwd-${Math.random().toString(36).slice(2)}`)
    try {
      await fs.writeFile(filename, 'x')
      return { content: [{ type: 'text', text: 'NO_ERROR' }] }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      return { content: [{ type: 'text', text: `${e.code}: ${e.message}` }] }
    }
  }

  if (toolName === 'probe_tcp_connect') {
    const port = (req.params.arguments as { port: number }).port
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      const cleanup = (text: string) => {
        socket.destroy()
        resolve({ content: [{ type: 'text', text }] })
      }
      socket.setTimeout(500)
      socket.on('connect', () => cleanup('NO_ERROR'))
      socket.on('timeout', () => cleanup('ETIMEDOUT: connection timed out'))
      socket.on('error', (err) => cleanup(`${(err as NodeJS.ErrnoException).code}: ${err.message}`))
    })
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
