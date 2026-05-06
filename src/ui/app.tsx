import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import path from 'path'
import { Box, Text } from 'ink'
import { runAgentLoop } from '../agent/loop.js'
import { parseSlashCommand } from './slash/dispatcher.js'
import { formatCost, formatMcp, formatMcpHelp, formatAgents, formatHooks, formatHelp, formatModel, formatContext, formatConfig } from './slash/format.js'
import { handleProfileSlash } from './slash/profile-handler.js'
import { exportSessionToMarkdown } from './slash/export-md.js'
import { loadSessionSummaries, SessionPicker } from '../session/resume.js'
import { loadSession } from '../session/store.js'
import { SUBAGENT_TYPES } from '../agent/subagent-types.js'
import type { MsgEntry } from '../session/types.js'
import { Chat } from './chat.js'
import { Input } from './input.js'
import { ToolStatus } from './tool-status.js'
import { StreamingText } from './streaming.js'
import { AskQuestion } from './ask-question.js'
import { PermissionPrompt } from './permission-prompt.js'
import { StatusBar } from './status-bar.js'
import { ModelPicker } from './model-picker.js'
import type { ProviderOption } from './model-picker.js'
import { checkPermission } from '../permissions/enforcer.js'
import { createSession, addTurn } from '../usage/tracker.js'
import { calculateTurnCost, getContextLimit } from '../usage/pricing.js'
import { appendMessage, appendUsage } from '../session/store.js'
import { previewCompact } from '../agent/compact.js'
import { shouldAutoCompact } from '../agent/context-threshold.js'
import { CompactPreview } from './compact-preview.js'
import { createProvider } from '../providers/registry.js'
import { FallbackProvider } from '../providers/fallback.js'
import { applyModelSelection } from '../config/model-selection.js'
import type { Provider, Message, ContentBlock } from '../providers/types.js'
import { modelSupportsVision } from '../providers/capabilities.js'
import type { SubmitPayload } from './input.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolContext } from '../tools/types.js'
import type { KristosConfig } from '../config/types.js'
import type { Skill } from '../skills/types.js'
import type { PermissionMode, PermissionRequest } from '../permissions/types.js'
import type { HookConfig, HookEvent, HookRunResult } from '../hooks/index.js'
import type { McpManager } from '../mcp/manager.js'
import type { SessionSummary } from '../session/types.js'
import type { PerModelUsage } from './slash/format.js'
import { loadSharedContext } from '../context/loader.js'
import type { LoadedContext } from '../context/loader.js'

interface AppProps {
  initialProvider: Provider
  registry: ToolRegistry
  config: KristosConfig
  /** Phase 19 (LEAN-01): unfiltered config for session /profile switching. */
  originalConfig?: KristosConfig
  /** Phase 19 (LEAN-01): profile name resolved at startup (from CLI or config). */
  initialActiveProfile?: string
  cwd: string
  skills?: Skill[]
  sessionId: string           // NEW
  initialMessages?: Message[] // NEW — for resume (Plan 02 uses this)
  permissionMode: PermissionMode
  hooks?: HookConfig
  mcpManager?: McpManager
  // Phase 17: security plumbing
  sessionTmpdir?: string        // /private/tmp/kc-<sessionId>, passed to sandbox
  sandboxAvailable?: boolean    // result of detectSandboxExec() at startup
}

export function App({ initialProvider, registry, config, originalConfig, initialActiveProfile, cwd, skills = [], sessionId, initialMessages = [], permissionMode: initialPermissionMode, hooks, mcpManager, sessionTmpdir, sandboxAvailable }: AppProps) {
  const [activeProfile, setActiveProfile] = useState<string | undefined>(initialActiveProfile)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialPermissionMode)
  const [provider, setProvider] = useState<Provider>(initialProvider)
  const [currentModel, setCurrentModel] = useState(config.model)
  const [currentProviderKey, setCurrentProviderKey] = useState(config.provider as string)
  // Phase 28 (ROUTE-03): true when the active profile overrides the top-level provider.
  const [profileOverridesProvider, setProfileOverridesProvider] = useState<boolean>(() => {
    if (!initialActiveProfile) return false
    const profile = config.profiles?.[initialActiveProfile]
    return profile?.provider !== undefined && profile.provider !== config.provider
  })
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [submitSignal, setSubmitSignal] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [activeTool, setActiveTool] = useState<{ name: string; args: unknown } | null>(null)
  const [lastToolResult, setLastToolResult] = useState<{ name: string; content: string; isError: boolean } | null>(null)
  const [isAskingUser, setIsAskingUser] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string
    options: string[]
    resolve: (answer: string) => void
  } | null>(null)
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null)
  const [allowAlwaysTools, setAllowAlwaysTools] = useState<Set<string>>(new Set())
  const [session, setSession] = useState(createSession())
  const [subagentActive, setSubagentActive] = useState(false)
  const [fallbackActive, setFallbackActive] = useState(false)
  const [showResumePicker, setShowResumePicker] = useState(false)
  const [resumeSummaries, setResumeSummaries] = useState<SessionSummary[]>([])
  const [perModelUsage, setPerModelUsage] = useState<Map<string, PerModelUsage>>(new Map())
  const [pendingCompact, setPendingCompact] = useState<{
    summary: string
    newMessages: Message[]
    beforeCount: number
    afterCount: number
    summaryTokens: number
    auto: boolean
  } | null>(null)
  const pendingCompactRef = useRef<typeof pendingCompact>(null)
  pendingCompactRef.current = pendingCompact
  const lastInputTokensRef = useRef<number>(0)

  // Phase 46 (CTX-01, CTX-02, CTX-04): shared context loaded once on mount.
  // Held in a ref so all runAgentLoop calls see the same loaded context without
  // re-triggering on every render.
  const sharedContextRef = useRef<LoadedContext | null>(null)

  // Load shared context once on mount; push budget warning as assistant message if needed
  useEffect(() => {
    void (async () => {
      const ctx = await loadSharedContext({ tokenBudget: config.contextTokenBudget })
      sharedContextRef.current = ctx
      if (ctx.budgetWarning) {
        const warnMessage: Message = {
          role: 'assistant',
          content: ctx.budgetWarning,
        }
        messagesRef.current = [...messagesRef.current, warnMessage]
        setMessages([...messagesRef.current])
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Wire FallbackProvider callback whenever provider changes (including initial mount)
  useEffect(() => {
    if (provider instanceof FallbackProvider) {
      provider.setOnFallbackActive(setFallbackActive)
    } else {
      // Non-fallback provider: reset indicator in case of provider switch
      setFallbackActive(false)
    }
  }, [provider])

  // Worktree tool mutates the live session cwd. Captured once per App lifetime;
  // currentCwdRef is read by every ToolContext build so subsequent tool calls see updates.
  const originalCwdRef = useRef<string>(cwd)
  const currentCwdRef = useRef<string>(cwd)

  // Streaming text buffer — chunks are accumulated here, drained to display every 16ms
  const textBufferRef = useRef<string>('')
  // Agent loop mutates this array in place; we hold the reference
  const messagesRef = useRef<Message[]>(initialMessages)

  // Promise bridge for ask_user_question tool
  const askUser = useCallback((question: string, options: string[]): Promise<string> => {
    return new Promise(resolve => {
      setIsAskingUser(true)
      setPendingQuestion({ question, options, resolve })
    })
  }, [])

  // Promise bridge for permission prompts — mirrors askUser pattern
  const requestPermission = useCallback(
    async (toolName: string, input: unknown): Promise<'allow' | 'deny'> => {
      const decision = checkPermission(permissionMode, toolName, input)
      if (decision.action === 'allow') return 'allow'
      if (decision.action === 'deny') return 'deny'
      // action === 'ask' — check allow-always first
      if (allowAlwaysTools.has(toolName)) return 'allow'
      // Show prompt and await user decision
      const userDecision = await new Promise<'allow' | 'deny' | 'allow-always'>(resolve => {
        setPermissionRequest({ toolName, command: decision.command, resolve })
      })
      if (userDecision === 'allow-always') {
        setAllowAlwaysTools(prev => new Set([...prev, toolName]))
        return 'allow'
      }
      return userDecision === 'allow' ? 'allow' : 'deny'
    },
    [permissionMode, allowAlwaysTools],
  )

  const handlePermissionDecision = useCallback((decision: 'allow' | 'deny' | 'allow-always') => {
    if (permissionRequest) {
      permissionRequest.resolve(decision)
      setPermissionRequest(null)
    }
  }, [permissionRequest])

  const cwdRef = {
    get: () => currentCwdRef.current,
    set: (next: string) => { currentCwdRef.current = next },
  }

  const toolContext: ToolContext = {
    cwd: currentCwdRef.current,
    toolTimeoutMs: config.toolTimeoutMs,
    askUser,
    checkPermission: permissionMode === 'yolo' ? undefined : requestPermission,
    cwdRef,
    originalCwd: originalCwdRef.current,
    // Phase 17: security/audit plumbing
    sessionId,
    mode: permissionMode,
    sessionTmpdir,
    sandboxAvailable,
    subagentParent: {
      provider,
      registry,
      apiSchemas: registry.toAPISchemaForProvider(provider.name),
      // Nested toolContext inherits parent's permission gate so subagent tool calls
      // hit the same checkPermission. We deliberately omit subagentParent here to
      // disallow recursive nesting in v1 — TODO: revisit if/when we want subagents
      // to spawn their own subagents.
      toolContext: {
        cwd: currentCwdRef.current,
        toolTimeoutMs: config.toolTimeoutMs,
        askUser,
        checkPermission: permissionMode === 'yolo' ? undefined : requestPermission,
        cwdRef,
        originalCwd: originalCwdRef.current,
        sessionId,
        mode: permissionMode,
        sessionTmpdir,
        sandboxAvailable,
      },
      temperature: config.temperature,
      windowSize: config.windowSize,
      maxIterations: config.maxIterations,
      hooks,
    },
    onSubagentStart: () => setSubagentActive(true),
    onSubagentEnd: () => setSubagentActive(false),
  }

  const handleAnswer = useCallback((answer: string) => {
    if (pendingQuestion) {
      pendingQuestion.resolve(answer)
      setIsAskingUser(false)
      setPendingQuestion(null)
    }
  }, [pendingQuestion])

  const runWithMessage = useCallback(async (content: string) => {
    const userMessage: Message = { role: 'user', content }
    messagesRef.current.push(userMessage)
    setMessages([...messagesRef.current])
    setSubmitSignal(n => n + 1)
    // Persist user message immediately (fire-and-forget — errors are silenced in store)
    void appendMessage(sessionId, userMessage)

    setIsProcessing(true)
    setActiveTool(null)
    setLastToolResult(null)

    const apiSchemas = registry.toAPISchemaForProvider(provider.name)
    const tools = registry.getToolsForProvider(provider.name)
    const planInstructions = permissionMode === 'plan'
      ? '\n\nPLAN MODE ACTIVE. Do NOT use bash, file_write, file_edit, or worktree — they are blocked. Instead, investigate using read-only tools (file_read, grep, glob) and then output a structured implementation plan as a markdown block with sections: ## Goal, ## Files to change, ## Steps (numbered), ## Risks. Wait for the user to switch out of plan mode (`/plan`) before taking action.'
      : ''
    const contextPrefix = sharedContextRef.current?.systemPromptPrefix ?? ''
    const systemPrompt = `You are a helpful coding assistant. Current working directory: ${cwd}${planInstructions}${contextPrefix ? '\n\n' + contextPrefix : ''}`

    try {
      // Capture length before loop to identify new messages added by the loop
      const beforeLen = messagesRef.current.length
      await runAgentLoop(messagesRef.current, {
        provider,
        tools,
        registry,
        apiSchemas,
        maxIterations: config.maxIterations,
        temperature: config.temperature,
        windowSize: config.windowSize,
        toolContext,
        systemPrompt,
        hooks,
        mcpManager,
        callbacks: {
          onHookWarning: (event: HookEvent, toolName: string, results: HookRunResult[]) => {
            for (const r of results) {
              const first = (r.stderr.trim() || r.stdout.trim() || (r.timedOut ? 'timed out' : '')).split('\n')[0] ?? ''
              const label = toolName ? `${event}:${toolName}` : event
              process.stderr.write(`\x1b[2m[hook:${label}] exit ${r.exitCode}: ${first}\x1b[0m\n`)
            }
          },
          onTextChunk: (chunk) => {
            // Append to buffer — drained by StreamingText's 16ms interval
            textBufferRef.current += chunk
          },
          onToolCall: (id, name, args) => {
            setActiveTool({ name, args })
            setLastToolResult(null)
          },
          onToolResult: (id, name, result, isError) => {
            setActiveTool(null)
            setLastToolResult({ name, content: result, isError })
          },
          onTurnComplete: (usage) => {
            // Flush remaining buffer to messages as assistant message
            // (the actual message was already pushed to messagesRef by runAgentLoop)
            setMessages([...messagesRef.current])
            setActiveTool(null)
            lastInputTokensRef.current = usage.inputTokens
            // Update session usage and append usage entry (best-effort, last write wins at crash)
            setSession(prev => {
              const updated = addTurn(prev, usage, config.model)
              void appendUsage(sessionId, {
                totalCostUsd: updated.totalCost,
                inputTokens: updated.totalInputTokens,
                outputTokens: updated.totalOutputTokens,
              })
              return updated
            })
            // Per-model usage accumulator for /cost
            setPerModelUsage(prev => {
              const key = `${currentProviderKey}/${currentModel}`
              const existing = prev.get(key) ?? { input: 0, output: 0, cost: 0 }
              const turnCost = calculateTurnCost(
                { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
                currentModel,
              )
              const next = new Map(prev)
              next.set(key, {
                input: existing.input + usage.inputTokens,
                output: existing.output + usage.outputTokens,
                cost: existing.cost + turnCost,
              })
              return next
            })
          },
        },
      })

      // Append all messages added during this loop run (assistant turns + tool results)
      const newMessages = messagesRef.current.slice(beforeLen)
      await Promise.all(newMessages.map(m => appendMessage(sessionId, m)))

      // Flush any remaining buffer content
      if (textBufferRef.current) {
        textBufferRef.current = ''
      }

      // Update messages state with final conversation
      setMessages([...messagesRef.current])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorMessage: Message = {
        role: 'assistant',
        content: `Error: ${errMsg}`,
      }
      messagesRef.current.push(errorMessage)
      setMessages([...messagesRef.current])
    } finally {
      setIsProcessing(false)
      setActiveTool(null)
    }

    // Auto-compact check — runs only after the agent loop fully settled,
    // so tool_use/tool_result pairs are intact. Guarded so we never double-trigger.
    const limit = getContextLimit(currentModel)
    const pct = limit > 0 ? lastInputTokensRef.current / limit : 0
    if (!pendingCompactRef.current && shouldAutoCompact(pct, config.autoCompactThreshold)) {
      void startCompactPreview(true)
    }
  }, [provider, registry, config, cwd, toolContext, sessionId, permissionMode, currentModel])

  const startCompactPreview = useCallback(async (auto: boolean) => {
    if (pendingCompactRef.current) return
    setIsProcessing(true)
    try {
      const contextPrefix = sharedContextRef.current?.systemPromptPrefix ?? ''
      const systemPrompt = `You are a helpful coding assistant. Current working directory: ${cwd}${contextPrefix ? '\n\n' + contextPrefix : ''}`
      const preview = await previewCompact(messagesRef.current, provider, systemPrompt)
      setPendingCompact({
        summary: preview.summary,
        newMessages: preview.newMessages,
        beforeCount: preview.beforeMessageCount,
        afterCount: preview.afterMessageCount,
        summaryTokens: preview.summaryTokens,
        auto,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorMessage: Message = {
        role: 'assistant',
        content: `[compact failed: ${errMsg}]`,
      }
      messagesRef.current.push(errorMessage)
      setMessages([...messagesRef.current])
    } finally {
      setIsProcessing(false)
    }
  }, [provider, cwd])

  const acceptCompact = useCallback(() => {
    const p = pendingCompactRef.current
    if (!p) return
    messagesRef.current = [...p.newMessages]
    setMessages([...messagesRef.current])
    const info: Message = {
      role: 'assistant',
      content: `[compact${p.auto ? ' · auto' : ''}] ${p.beforeCount} → ${p.afterCount} messages, ~${p.summaryTokens} summary tokens`,
    }
    messagesRef.current.push(info)
    setMessages([...messagesRef.current])
    setPendingCompact(null)
  }, [])

  const cancelCompact = useCallback(() => {
    setPendingCompact(null)
    const info: Message = { role: 'assistant', content: '[compact cancelled]' }
    messagesRef.current.push(info)
    setMessages([...messagesRef.current])
  }, [])

  const providerOptions: ProviderOption[] = useMemo(
    () =>
      Object.entries(config.providerConfigs).map(([key, pc]) => ({
        providerKey: key,
        model: pc.model,
        label: `${key} / ${pc.model}`,
      })),
    [config.providerConfigs],
  )

  const handleModelSelect = useCallback(
    (option: ProviderOption) => {
      try {
        const newConfig = applyModelSelection(config, option)
        const newProvider = createProvider(newConfig)
        setProvider(newProvider)
        setCurrentModel(option.model)
        setCurrentProviderKey(option.providerKey)
        setProfileOverridesProvider(false)
        setShowModelPicker(false)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const info: Message = {
          role: 'assistant',
          content: `[model switch failed] ${message}`,
        }
        messagesRef.current.push(info)
        setMessages([...messagesRef.current])
        setShowModelPicker(false)
      }
    },
    [config],
  )

  const handleSubmit = useCallback(async (text: string) => {
    // Built-in slash commands
    if (text === '/compact') {
      if (isProcessing || pendingCompact) return
      await startCompactPreview(false)
      return
    }

    if (text === '/model') {
      const modelInfo: Message = {
        role: 'assistant',
        content: formatModel(currentProviderKey, currentModel, activeProfile, profileOverridesProvider),
      }
      messagesRef.current.push(modelInfo)
      setMessages([...messagesRef.current])
      setShowModelPicker(true)
      return
    }

    if (text === '/plan') {
      const next: PermissionMode = permissionMode === 'plan' ? 'yolo' : 'plan'
      setPermissionMode(next)
      const info: Message = {
        role: 'assistant',
        content: next === 'plan'
          ? '[plan mode ON] I will propose a plan and wait for approval. Toggle off with /plan.'
          : '[plan mode OFF] Resuming normal execution.',
      }
      messagesRef.current.push(info)
      setMessages([...messagesRef.current])
      return
    }

    if (text === '/clear') {
      messagesRef.current = []
      setMessages([])
      setSession(createSession())
      return
    }

    // Phase 13 slash commands (parsed via dispatcher)
    const parsed = parseSlashCommand(text)
    if (parsed) {
      const pushAssistant = (content: string) => {
        const msg: Message = { role: 'assistant', content }
        messagesRef.current.push(msg)
        setMessages([...messagesRef.current])
      }

      switch (parsed.name) {
        case 'help': {
          pushAssistant(formatHelp())
          return
        }
        case 'cost': {
          const arg = parsed.arg
          const verbose = arg === 'verbose' || arg === '-v' || arg === '--verbose'
          pushAssistant(
            formatCost(
              session,
              currentModel,
              currentProviderKey,
              perModelUsage,
              undefined,
              { verbose, tools: verbose ? registry.getAll() : undefined },
            ),
          )
          return
        }
        case 'resume': {
          const summaries = await loadSessionSummaries(20)
          setResumeSummaries(summaries)
          setShowResumePicker(true)
          return
        }
        case 'export': {
          const md = exportSessionToMarkdown(messagesRef.current, {
            sessionId,
            model: currentModel,
            providerKey: currentProviderKey,
            startedAt: Date.now(),
          })
          if (parsed.arg === '') {
            pushAssistant(md)
          } else {
            const abs = path.isAbsolute(parsed.arg) ? parsed.arg : path.join(cwd, parsed.arg)
            try {
              await Bun.write(abs, md)
              pushAssistant(`[exported ${messagesRef.current.length} messages → ${abs}]`)
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              pushAssistant(`[export failed: ${errMsg}]`)
            }
          }
          return
        }
        case 'mcp': {
          if (!mcpManager) {
            pushAssistant(formatMcp([]))
            return
          }
          const [sub, ...rest] = parsed.arg.trim().split(/\s+/).filter(Boolean)
          const target = rest.join(' ')
          try {
            switch (sub ?? '') {
              case '':
              case 'list':
                pushAssistant(formatMcp(mcpManager.list()))
                break
              case 'enable':
                if (!target) { pushAssistant('Usage: /mcp enable <name>'); break }
                mcpManager.enable(target)
                pushAssistant(formatMcp(mcpManager.list()))
                break
              case 'disable':
                if (!target) { pushAssistant('Usage: /mcp disable <name>'); break }
                void mcpManager.disable(target).catch(() => {})
                pushAssistant(formatMcp(mcpManager.list()))
                break
              case 'spawn':
                if (!target) { pushAssistant('Usage: /mcp spawn <name>'); break }
                await mcpManager.spawn(target)
                pushAssistant(formatMcp(mcpManager.list()))
                break
              case 'kill':
                if (!target) { pushAssistant('Usage: /mcp kill <name>'); break }
                await mcpManager.kill(target)
                pushAssistant(formatMcp(mcpManager.list()))
                break
              default:
                pushAssistant(formatMcpHelp())
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            pushAssistant(`/mcp ${sub ?? ''}${target ? ' ' + target : ''} failed: ${msg}`)
          }
          return
        }
        case 'profile': {
          if (!mcpManager || !originalConfig) {
            pushAssistant('[profile] unavailable (no MCP manager)')
            return
          }
          const result = await handleProfileSlash(parsed.arg, originalConfig, activeProfile, mcpManager)
          setActiveProfile(result.newActiveProfile)
          if (result.providerUpdate) {
            setProvider(result.providerUpdate.provider)
            setCurrentProviderKey(result.providerUpdate.providerKey)
            setCurrentModel(result.providerUpdate.model)
            setProfileOverridesProvider(result.providerUpdate.profileOverridesProvider)
          }
          pushAssistant(result.message)
          return
        }
        case 'agents': {
          pushAssistant(formatAgents(SUBAGENT_TYPES as Array<{ name: string; description: string }>))
          return
        }
        case 'hooks': {
          pushAssistant(formatHooks(hooks))
          return
        }
        case 'config': {
          pushAssistant(formatConfig(config))
          return
        }
        case 'context': {
          pushAssistant(formatContext(sharedContextRef.current))
          return
        }
      }
    }

    // Slash command dispatch: /skill-name → inject skill content
    if (text.startsWith('/') && text.length > 1) {
      const cmdName = text.slice(1).trim().split(/\s/)[0]
      const skill = skills.find(s => s.name === cmdName)
      if (skill) {
        await runWithMessage(skill.content)
        return
      }
    }
    // Normal message (or unknown slash command — sent as-is)
    await runWithMessage(text)
  }, [skills, runWithMessage, isProcessing, provider, cwd, permissionMode, session, currentModel, currentProviderKey, perModelUsage, sessionId, mcpManager, registry, hooks, pendingCompact, startCompactPreview, originalConfig, activeProfile])

  // Phase 21-03: vision capability of the active provider+model.
  const visionCapable = useMemo(
    () => modelSupportsVision(currentProviderKey, currentModel),
    [currentProviderKey, currentModel],
  )

  // Phase 21-03: SubmitPayload entry point — Input gives us text + attachments.
  // Slash commands and text-only paths are routed through handleSubmit unchanged.
  // Multimodal paths build a ContentBlock[] user message and run the agent loop.
  const handlePayloadSubmit = useCallback(async (payload: SubmitPayload) => {
    if (payload.attachments.length === 0) {
      await handleSubmit(payload.text)
      return
    }
    // With attachments and text: skip the slash-command path entirely. Slash
    // commands cannot meaningfully accept image input, and any '/' prefix here
    // is intended as plain text alongside the image.
    const blocks: ContentBlock[] = []
    if (payload.text.length > 0) {
      blocks.push({ type: 'text', text: payload.text })
    }
    for (const a of payload.attachments) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', mediaType: a.mediaType, data: a.data },
      })
    }
    const userMessage: Message = { role: 'user', content: blocks }
    messagesRef.current.push(userMessage)
    setMessages([...messagesRef.current])
    void appendMessage(sessionId, userMessage)
    setSubmitSignal(n => n + 1)

    setIsProcessing(true)
    setActiveTool(null)
    setLastToolResult(null)

    const apiSchemas = registry.toAPISchemaForProvider(provider.name)
    const tools = registry.getToolsForProvider(provider.name)
    const contextPrefix = sharedContextRef.current?.systemPromptPrefix ?? ''
    const systemPrompt = `You are a helpful coding assistant. Current working directory: ${cwd}${contextPrefix ? '\n\n' + contextPrefix : ''}`

    try {
      const beforeLen = messagesRef.current.length
      await runAgentLoop(messagesRef.current, {
        provider,
        tools,
        registry,
        apiSchemas,
        maxIterations: config.maxIterations,
        temperature: config.temperature,
        windowSize: config.windowSize,
        toolContext,
        systemPrompt,
        hooks,
        mcpManager,
        callbacks: {
          onTextChunk: (chunk) => { textBufferRef.current += chunk },
          onToolCall: (id, name, args) => {
            setActiveTool({ name, args })
            setLastToolResult(null)
          },
          onToolResult: (id, name, result, isError) => {
            setActiveTool(null)
            setLastToolResult({ name, content: result, isError })
          },
          onTurnComplete: (usage) => {
            setMessages([...messagesRef.current])
            setActiveTool(null)
            lastInputTokensRef.current = usage.inputTokens
            setSession(prev => addTurn(prev, usage, config.model))
          },
        },
      })
      const newMessages = messagesRef.current.slice(beforeLen)
      await Promise.all(newMessages.map(m => appendMessage(sessionId, m)))
      if (textBufferRef.current) textBufferRef.current = ''
      setMessages([...messagesRef.current])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      messagesRef.current.push({ role: 'assistant', content: `Error: ${errMsg}` })
      setMessages([...messagesRef.current])
    } finally {
      setIsProcessing(false)
      setActiveTool(null)
    }
  }, [handleSubmit, provider, registry, config, cwd, toolContext, sessionId, hooks, mcpManager])

  const handleResumeSelect = useCallback(async (summary: SessionSummary) => {
    try {
      const entries = await loadSession(summary.id)
      const msgs = entries
        .filter((e): e is MsgEntry => e.type === 'msg')
        .map(e => e.message)
      messagesRef.current = msgs
      setMessages([...msgs])
      const note: Message = {
        role: 'assistant',
        content: `[resumed view of session ${summary.id} — ${msgs.length} messages loaded]`,
      }
      messagesRef.current.push(note)
      setMessages([...messagesRef.current])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const note: Message = { role: 'assistant', content: `[resume failed: ${errMsg}]` }
      messagesRef.current.push(note)
      setMessages([...messagesRef.current])
    } finally {
      setShowResumePicker(false)
    }
  }, [])

  return (
    <Box flexDirection="column">
      <Text bold color="blue">kc</Text>
      <Text dimColor>{currentProviderKey} / {currentModel}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Chat messages={messages} collapseThreshold={config.ui?.toolOutputCollapseThreshold ?? 10} submitSignal={submitSignal} />
        <StreamingText bufferRef={textBufferRef} isStreaming={isProcessing} />
        <ToolStatus activeTool={activeTool} lastResult={lastToolResult} />
        {permissionRequest ? (
          <PermissionPrompt
            toolName={permissionRequest.toolName}
            command={permissionRequest.command}
            onDecision={handlePermissionDecision}
          />
        ) : pendingCompact ? (
          <CompactPreview
            summary={pendingCompact.summary}
            beforeCount={pendingCompact.beforeCount}
            afterCount={pendingCompact.afterCount}
            summaryTokens={pendingCompact.summaryTokens}
            auto={pendingCompact.auto}
            onAccept={acceptCompact}
            onCancel={cancelCompact}
          />
        ) : showResumePicker ? (
          <SessionPicker
            summaries={resumeSummaries}
            onSelect={handleResumeSelect}
            onCancel={() => setShowResumePicker(false)}
          />
        ) : showModelPicker ? (
          <ModelPicker
            options={providerOptions}
            currentModel={currentModel}
            currentProviderKey={currentProviderKey}
            onSelect={handleModelSelect}
            onCancel={() => setShowModelPicker(false)}
            ollamaBaseUrl={config.providerConfigs.ollama?.baseURL}
            llamacppBaseUrl={config.providerConfigs.llamacpp?.baseURL}
            llamacppApiKey={config.providerConfigs.llamacpp?.apiKey}
          />
        ) : isAskingUser && pendingQuestion ? (
          <AskQuestion
            question={pendingQuestion.question}
            options={pendingQuestion.options}
            onAnswer={handleAnswer}
          />
        ) : (
          <Input
            isProcessing={isProcessing}
            onSubmit={handlePayloadSubmit}
            skills={skills}
            visionCapable={visionCapable}
            currentModelLabel={currentModel}
          />
        )}
        <StatusBar
          session={session}
          model={currentModel}
          providerName={currentProviderKey}
          permissionMode={permissionMode}
          subagentActive={subagentActive}
          fallbackActive={fallbackActive}
        />
      </Box>
    </Box>
  )
}
