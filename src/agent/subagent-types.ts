/**
 * Canonical list of subagent types available to the task tool and the
 * `/agents` slash command. Phase 10's task tool will import this same
 * constant when it lands.
 */

export interface SubagentType {
  name: string
  description: string
}

export const SUBAGENT_TYPES: ReadonlyArray<SubagentType> = [
  {
    name: 'general-purpose',
    description:
      'General-purpose agent for research, code review, and multi-step tasks',
  },
] as const
