export type PermissionMode = 'yolo' | 'ask' | 'readonly' | 'plan' | 'agent'

export type PermissionDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; toolName: string; command: string }

export interface PermissionRequest {
  toolName: string
  command: string
  resolve: (decision: 'allow' | 'deny' | 'allow-always') => void
}
