import { bashTool } from './bash.js'
import { fileReadTool } from './file-read.js'
import { fileWriteTool } from './file-write.js'
import { fileEditTool } from './file-edit.js'
import { grepTool } from './grep.js'
import { globTool } from './glob.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { askUserQuestionTool } from './ask-user-question.js'
import { todoWriteTool } from './todo-write.js'
import { taskTool } from './task.js'
import { worktreeTool } from './worktree.js'
import { makeIndexAwareGlob, makeIndexAwareGrep } from './index-aware.js'
import type { Tool } from '../types.js'
import type { KristosConfig } from '../../config/types.js'
import type { IndexClient } from '../../project-index/client.js'
import { registerCliTools } from '../../cli-tools/register.js'

export const allBuiltinTools: Tool[] = [
  bashTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  webFetchTool,
  webSearchTool,
  askUserQuestionTool,
  todoWriteTool,
  taskTool,
  worktreeTool,
]

/**
 * Phase 20 (LEAN-02): compose builtin tools with configured CLI tools.
 * Callers that still want the pure builtin set can continue to import
 * `allBuiltinTools`. New callers that want CLI tools use this function.
 *
 * Phase 48: optional IndexClient parameter wraps glob and grep with
 * index-aware variants. Passing null/undefined leaves behavior unchanged.
 */
export function buildAllTools(config: KristosConfig, indexClient?: IndexClient | null): Tool[] {
  const builtins = indexClient
    ? allBuiltinTools.map((tool) => {
        if (tool.name === 'glob') return makeIndexAwareGlob(tool, indexClient)
        if (tool.name === 'grep') return makeIndexAwareGrep(tool, indexClient)
        return tool
      })
    : [...allBuiltinTools]

  return [...builtins, ...registerCliTools(config)]
}
