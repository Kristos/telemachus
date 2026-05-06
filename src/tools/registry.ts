import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool } from './types.js'
import type { APIToolSchema } from '../providers/types.js'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  find(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return [...this.tools.values()]
  }

  /** Returns API-ready tool schemas. Server tools are included with isServerTool:true
   * so downstream consumers can route them (e.g. Anthropic beta routing). */
  toAPISchema(): APIToolSchema[] {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.rawInputSchema ?? (t.isServerTool ? {} : zodToJsonSchema(t.inputSchema, { target: 'openApi3' }) as Record<string, unknown>),
      isServerTool: t.isServerTool,
    }))
  }

  /** Returns tools filtered for a specific provider type */
  getToolsForProvider(providerName: string): Tool[] {
    if (providerName === 'anthropic') return this.getAll()
    return this.getAll().filter(t => t.name !== 'web_search')
  }

  /** Returns API schemas filtered for a specific provider.
   * Server tools are included with isServerTool:true so providers can handle them specially. */
  toAPISchemaForProvider(providerName: string): APIToolSchema[] {
    const tools = this.getToolsForProvider(providerName)
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.rawInputSchema ?? (t.isServerTool ? {} : zodToJsonSchema(t.inputSchema, { target: 'openApi3' }) as Record<string, unknown>),
      isServerTool: t.isServerTool,
    }))
  }
}
