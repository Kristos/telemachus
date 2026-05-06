/**
 * Phase 46 (CTX-01, CTX-02, CTX-04): Shared context file loader.
 * Phase 67 (AGMEM-01..03): optional per-agent memory extension.
 *
 * Loads CLAUDE.md (and fallbacks) into a structured result for prepending to
 * the system prompt. Mirrors Claude Code's context file discovery hierarchy.
 *
 * File search hierarchy for CLAUDE.md (all that exist loaded in order):
 *   1. Global:  {homedir}/.claude/CLAUDE.md
 *   2. Project: {cwd}/.claude/CLAUDE.md
 *   3. Local:   {cwd}/CLAUDE.md
 *
 * If zero CLAUDE.md files found, falls back to:
 *   - {cwd}/AGENTS.md
 *
 * Memory file (first match wins):
 *   1. {cwd}/KC_MEMORY.md  — preferred to avoid concurrent-writer conflicts
 *   2. {cwd}/MEMORY.md
 *
 * Per-agent memory (Phase 67, when opts.agentName is set):
 *   {homedir}/.telemachus/agent-memory/<agentName>/MEMORY.md
 *
 * Per-agent memory is appended AFTER the global memory block (later = more
 * specific) and participates in the totalBytes / totalEstimatedTokens /
 * budgetWarning aggregation. Silently skipped when the file is absent.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as os from 'node:os'

export interface ContextFile {
  /** Absolute path on disk */
  path: string
  /** File content */
  content: string
  /** Role of this file in the hierarchy */
  source: 'global' | 'project' | 'local' | 'memory' | 'agent'
  /** Human-readable label shown in section header */
  label: string
  bytes: number
  /** Rough estimate: Math.ceil(bytes / 4) */
  estimatedTokens: number
}

export interface LoadedContext {
  files: ContextFile[]
  /** Joined content with section headers, ready to prepend to system prompt */
  systemPromptPrefix: string
  totalBytes: number
  totalEstimatedTokens: number
  /** Non-null when combined tokens exceed the configured budget */
  budgetWarning: string | null
}

export interface ContextLoaderOptions {
  /** Working directory to resolve relative paths from. Default: process.cwd() */
  cwd?: string
  /** Home directory for global context. Default: os.homedir() */
  homedir?: string
  /** Max estimated tokens before warning. Default: 8000 */
  tokenBudget?: number
  /**
   * Phase 67 (AGMEM-01): when set, also load per-agent memory from
   * `{homedir}/.telemachus/agent-memory/<agentName>/MEMORY.md`. Appended
   * AFTER the KC_MEMORY.md / MEMORY.md block. Silently no-op when the file
   * doesn't exist. Convention:
   *   - Discord bot:    'discord'
   *   - Headless agent: the job name from config (e.g., 'daily-summary')
   *   - CLI:            unset (backward-compatible with Phase 46 behavior)
   */
  agentName?: string
}

/**
 * Attempt to read a file; returns null if it doesn't exist or can't be read.
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Build a ContextFile record from path, content, source, and label.
 */
function makeContextFile(
  filePath: string,
  content: string,
  source: ContextFile['source'],
  label: string,
): ContextFile {
  const bytes = Buffer.byteLength(content, 'utf8')
  const estimatedTokens = Math.ceil(bytes / 4)
  return {
    path: filePath,
    content,
    source,
    label,
    bytes,
    estimatedTokens,
  }
}

/**
 * Build the systemPromptPrefix from a list of ContextFile records.
 * Each file gets its own section header.
 */
function buildSystemPromptPrefix(files: ContextFile[]): string {
  if (files.length === 0) return ''
  return files
    .map(f => `--- Project Context (${f.label}) ---\n${f.content}\n`)
    .join('\n')
}

/**
 * Load shared context files from the CLAUDE.md hierarchy, AGENTS.md fallback,
 * and KC_MEMORY.md / MEMORY.md. Returns a LoadedContext ready for use in the
 * system prompt.
 */
export async function loadSharedContext(opts?: ContextLoaderOptions): Promise<LoadedContext> {
  const cwd = opts?.cwd ?? process.cwd()
  const homedir = opts?.homedir ?? os.homedir()
  const tokenBudget = opts?.tokenBudget ?? 8000

  const files: ContextFile[] = []

  // ————————————————————————————————————————————————————————————————————————
  // CLAUDE.md hierarchy — load all that exist
  // ————————————————————————————————————————————————————————————————————————

  const globalPath = join(homedir, '.claude', 'CLAUDE.md')
  const projectPath = join(cwd, '.claude', 'CLAUDE.md')
  const localPath = join(cwd, 'CLAUDE.md')

  const globalContent = await tryReadFile(globalPath)
  if (globalContent !== null) {
    files.push(makeContextFile(globalPath, globalContent, 'global', '~/.claude/CLAUDE.md'))
  }

  const projectContent = await tryReadFile(projectPath)
  if (projectContent !== null) {
    files.push(makeContextFile(projectPath, projectContent, 'project', '.claude/CLAUDE.md'))
  }

  const localContent = await tryReadFile(localPath)
  if (localContent !== null) {
    files.push(makeContextFile(localPath, localContent, 'local', 'CLAUDE.md'))
  }

  // ————————————————————————————————————————————————————————————————————————
  // AGENTS.md fallback — only when no CLAUDE.md was found
  // ————————————————————————————————————————————————————————————————————————

  if (files.length === 0) {
    const agentsPath = join(cwd, 'AGENTS.md')
    const agentsContent = await tryReadFile(agentsPath)
    if (agentsContent !== null) {
      files.push(makeContextFile(agentsPath, agentsContent, 'local', 'AGENTS.md'))
    }
  }

  // ————————————————————————————————————————————————————————————————————————
  // Memory file — KC_MEMORY.md preferred, MEMORY.md fallback
  // ————————————————————————————————————————————————————————————————————————

  const kcMemoryPath = join(cwd, 'KC_MEMORY.md')
  const memoryPath = join(cwd, 'MEMORY.md')

  const kcMemoryContent = await tryReadFile(kcMemoryPath)
  if (kcMemoryContent !== null) {
    files.push(makeContextFile(kcMemoryPath, kcMemoryContent, 'memory', 'KC_MEMORY.md'))
  } else {
    const memoryContent = await tryReadFile(memoryPath)
    if (memoryContent !== null) {
      files.push(makeContextFile(memoryPath, memoryContent, 'memory', 'MEMORY.md'))
    }
  }

  // ————————————————————————————————————————————————————————————————————————
  // Per-agent memory (Phase 67, AGMEM-01) — appended AFTER KC_MEMORY.md
  // ————————————————————————————————————————————————————————————————————————

  if (opts?.agentName) {
    const agentMemoryPath = join(
      homedir,
      '.telemachus',
      'agent-memory',
      opts.agentName,
      'MEMORY.md',
    )
    const agentContent = await tryReadFile(agentMemoryPath)
    if (agentContent !== null) {
      files.push(
        makeContextFile(agentMemoryPath, agentContent, 'agent', `agent:${opts.agentName}`),
      )
    }
  }

  // ————————————————————————————————————————————————————————————————————————
  // Aggregate stats and build output
  // ————————————————————————————————————————————————————————————————————————

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0)
  const totalEstimatedTokens = files.reduce((sum, f) => sum + f.estimatedTokens, 0)
  const systemPromptPrefix = buildSystemPromptPrefix(files)

  let budgetWarning: string | null = null
  if (totalEstimatedTokens > tokenBudget) {
    budgetWarning = `Warning: Context files total ~${totalEstimatedTokens} tokens (budget: ${tokenBudget}). Consider trimming context files.`
    process.stderr.write(`${budgetWarning}\n`)
  }

  return {
    files,
    systemPromptPrefix,
    totalBytes,
    totalEstimatedTokens,
    budgetWarning,
  }
}
