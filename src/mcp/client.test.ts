import { describe, it, expect, mock } from 'bun:test'
import { bridgeMcpTools, loadMcpClients } from './client.js'
import { ToolRegistry } from '../tools/registry.js'

// Minimal mock Client that satisfies the interface needed by bridgeMcpTools
function makeMockClient(toolResults?: Record<string, unknown>) {
  return {
    callTool: async (params: { name: string; arguments: Record<string, unknown> }) => {
      const result = toolResults?.[params.name]
      return {
        content: [{ type: 'text', text: result !== undefined ? String(result) : `called ${params.name}` }],
        isError: false,
      }
    },
  }
}

describe('bridgeMcpTools', () => {
  it('names tools as mcp__serverName__toolName', () => {
    const client = makeMockClient() as unknown as Parameters<typeof bridgeMcpTools>[1]
    const tools = bridgeMcpTools('my-server', client, [
      { name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object' } },
    ])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp__my-server__do_thing')
  })

  it('preserves description from MCP tool', () => {
    const client = makeMockClient() as unknown as Parameters<typeof bridgeMcpTools>[1]
    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool1', description: 'My description', inputSchema: { type: 'object' } },
    ])
    expect(tools[0].description).toBe('My description')
  })

  it('falls back to default description when MCP tool has none', () => {
    const client = makeMockClient() as unknown as Parameters<typeof bridgeMcpTools>[1]
    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool1', inputSchema: { type: 'object' } },
    ])
    expect(tools[0].description).toContain('srv')
  })

  it('stores rawInputSchema from MCP tool', () => {
    const client = makeMockClient() as unknown as Parameters<typeof bridgeMcpTools>[1]
    const schema = { type: 'object' as const, properties: { foo: { type: 'string' } } }
    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool1', inputSchema: schema },
    ])
    expect(tools[0].rawInputSchema).toEqual(schema)
  })

  it('execute calls client.callTool with correct { name, arguments } shape', async () => {
    let capturedParams: unknown = null
    const client = {
      callTool: async (params: unknown) => {
        capturedParams = params
        return {
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }
      },
    } as unknown as Parameters<typeof bridgeMcpTools>[1]

    const tools = bridgeMcpTools('srv', client, [
      { name: 'my_tool', inputSchema: { type: 'object' } },
    ])

    await tools[0].execute({ key: 'value' }, {
      cwd: '/tmp',
      toolTimeoutMs: 5000,
      askUser: async () => 'answer',
    })

    expect(capturedParams).toEqual({ name: 'my_tool', arguments: { key: 'value' } })
  })

  it('execute extracts text from content blocks', async () => {
    const client = {
      callTool: async () => ({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', data: 'base64...' },  // non-text block — should be filtered
          { type: 'text', text: 'line two' },
        ],
        isError: false,
      }),
    } as unknown as Parameters<typeof bridgeMcpTools>[1]

    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool', inputSchema: { type: 'object' } },
    ])

    const result = await tools[0].execute({}, {
      cwd: '/tmp',
      toolTimeoutMs: 5000,
      askUser: async () => 'answer',
    })

    expect(result.content).toBe('line one\nline two')
    expect(result.isError).toBe(false)
  })

  it('execute returns isError true when MCP result has isError: true', async () => {
    const client = {
      callTool: async () => ({
        content: [{ type: 'text', text: 'server error' }],
        isError: true,
      }),
    } as unknown as Parameters<typeof bridgeMcpTools>[1]

    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool', inputSchema: { type: 'object' } },
    ])

    const result = await tools[0].execute({}, {
      cwd: '/tmp',
      toolTimeoutMs: 5000,
      askUser: async () => 'answer',
    })

    expect(result.isError).toBe(true)
  })

  it('execute handles callTool rejection gracefully', async () => {
    const client = {
      callTool: async () => { throw new Error('connection refused') },
    } as unknown as Parameters<typeof bridgeMcpTools>[1]

    const tools = bridgeMcpTools('srv', client, [
      { name: 'tool', inputSchema: { type: 'object' } },
    ])

    const result = await tools[0].execute({}, {
      cwd: '/tmp',
      toolTimeoutMs: 5000,
      askUser: async () => 'answer',
    })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('connection refused')
  })

  it('handles multiple tools from the same server', () => {
    const client = makeMockClient() as unknown as Parameters<typeof bridgeMcpTools>[1]
    const tools = bridgeMcpTools('analytics', client, [
      { name: 'get_data', inputSchema: { type: 'object' } },
      { name: 'post_data', inputSchema: { type: 'object' } },
    ])
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('mcp__analytics__get_data')
    expect(tools[1].name).toBe('mcp__analytics__post_data')
  })
})

describe('loadMcpClients', () => {
  it('returns empty serverStatus and toolCount=0 when mcpServers is empty', async () => {
    const registry = new ToolRegistry()
    const result = await loadMcpClients(registry, {})
    expect(result.serverStatus.size).toBe(0)
    expect(result.toolCount).toBe(0)
  })

  it('returns empty serverStatus when mcpServers is undefined', async () => {
    const registry = new ToolRegistry()
    const result = await loadMcpClients(registry, { mcpServers: undefined })
    expect(result.serverStatus.size).toBe(0)
    expect(result.toolCount).toBe(0)
  })

  it('marks server as error when command does not exist', async () => {
    const registry = new ToolRegistry()
    const result = await loadMcpClients(registry, {
      mcpServers: {
        'nonexistent': {
          command: 'this-command-does-not-exist-12345',
          args: [],
        },
      },
    })
    // Should fail gracefully — either 'error' or 'timeout', never crashes
    expect(result.serverStatus.has('nonexistent')).toBe(true)
    const status = result.serverStatus.get('nonexistent')
    const validStatuses: string[] = ['error', 'timeout', 'dead']
    expect(validStatuses.includes(status ?? '')).toBe(true)
  }, 10_000)  // Allow up to 10s for timeout detection
})
