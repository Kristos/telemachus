import React from 'react'
import { Box, Text, useInput } from 'ink'

interface PermissionPromptProps {
  toolName: string
  command: string
  onDecision: (d: 'allow' | 'deny' | 'allow-always') => void
}

export function PermissionPrompt({ toolName, command, onDecision }: PermissionPromptProps) {
  useInput((char) => {
    if (char === 'y' || char === 'Y') onDecision('allow')
    if (char === 'n' || char === 'N') onDecision('deny')
    if (char === 'a' || char === 'A') onDecision('allow-always')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission Required</Text>
      <Text>Tool: <Text color="cyan">{toolName}</Text></Text>
      <Text dimColor>{command}</Text>
      <Box marginTop={1}>
        <Text>[y] Allow  [n] Deny  [a] Allow Always (this session)</Text>
      </Box>
    </Box>
  )
}
