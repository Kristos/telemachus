export type McpServerStatus =
  | 'alive'
  | 'dead'
  | 'error'
  | 'timeout'
  | 'idle'
  | 'disabled'
  | 'lazy'

export interface McpLoadResult {
  serverStatus: Map<string, McpServerStatus>
  toolCount: number
}
