import { homedir } from 'os'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { z } from 'zod'
import { DEFAULT_CONFIG, type KristosConfig } from './types.js'
import { expandMcpServerEnv } from './env-expand.js'

// Phase 55: narrow Zod validator for the new concurrency field only.
// We do not validate the whole KristosConfig via Zod yet (separate phase);
// this targeted schema catches out-of-range maxInflightLLMRequests.
const MaxInflightSchema = z.number().int().min(1).max(32)

// Phase 56 (TRUNC-01): narrow Zod validator for discord.maxConversationTurns.
const MaxConversationTurnsSchema = z.number().int().min(1).max(1000)

// Phase 56 (BUDGET-01): narrow Zod validator for discord.dailyTokensPerUser.
const DailyTokensPerUserSchema = z.number().int().min(1000).max(1_000_000_000)

// Phase 60 (DISPATCH-08): narrow Zod validator for discord.autoDispatch.
// cancellationWindowMs bounded [1000, 30000], defaults to 10000 when enabled:true
// and the field is absent. Invalid shapes drop the whole autoDispatch block.
const AutoDispatchSchema = z.object({
  enabled: z.boolean(),
  cancellationWindowMs: z.number().int().min(1000).max(30000).default(10000),
})

// Phase 64 (PERS-01): Zod validator for discord.personas.
// Values capped at 4000 chars to prevent accidental megabyte persona blobs.
// Keys must be non-empty strings (Discord snowflakes are always long — rely on
// Discord API to reject malformed IDs at runtime).
const PersonasSchema = z.record(z.string().min(1), z.string().min(1).max(4000))

// Phase 64 (PERS-02): Zod validator for discord.suppressEmoji.
// Invalid shape (non-boolean value, empty key) drops the whole field.
const SuppressEmojiSchema = z.record(z.string().min(1), z.boolean())

// Phase 59 (ROUTE-08): Zod validator for profile.routerConfig.
// Narrow validation only — matches the existing loader pattern where
// individual fields get schemas rather than the whole KristosConfig object.
const ProviderEnumSchema = z.enum(['anthropic', 'openai-compat', 'llamacpp'])
export const RouterConfigSchema = z.object({
  classifier: ProviderEnumSchema,
  simple: ProviderEnumSchema,
  complex: ProviderEnumSchema,
  classifierModel: z.string().min(1).optional(),
  simpleModel: z.string().min(1).optional(),
  complexModel: z.string().min(1).optional(),
  heuristicEnabled: z.boolean().optional(),
  classifierTokenCap: z.number().int().min(100).max(10000).optional(),
  classifierTimeoutMs: z.number().int().min(500).max(60000).optional(),
  fallbacks: z.object({
    classifier: ProviderEnumSchema.optional(),
    simple: ProviderEnumSchema.optional(),
    complex: ProviderEnumSchema.optional(),
  }).optional(),
}).strict()


function getConfigPaths() {
  // Prefer $HOME so tests can override; fall back to os.homedir().
  const home = process.env.HOME ?? homedir()
  const dir = join(home, '.telemachus')
  return { dir, file: join(dir, 'config.json') }
}

async function readJsonSafe(path: string): Promise<Partial<KristosConfig>> {
  try {
    return await Bun.file(path).json()
  } catch {
    return {}
  }
}

function mergeProviderConfigs(
  base: KristosConfig['providerConfigs'],
  override: Partial<KristosConfig>['providerConfigs'],
): KristosConfig['providerConfigs'] {
  if (!override) return base
  const merged: KristosConfig['providerConfigs'] = { ...base }
  for (const key of Object.keys(override)) {
    merged[key] = { ...base[key], ...override[key] }
  }
  return merged
}

export async function loadConfig(cwd = process.cwd()): Promise<KristosConfig> {
  const { dir: configDir, file: globalConfigPath } = getConfigPaths()
  // Auto-create global config if it doesn't exist
  const configExists = await Bun.file(globalConfigPath).exists()
  if (!configExists) {
    await mkdir(configDir, { recursive: true })
    await Bun.write(globalConfigPath, JSON.stringify(DEFAULT_CONFIG, null, 2))
    process.stderr.write(
      'Created ~/.telemachus/config.json — set ANTHROPIC_API_KEY to get started.\n',
    )
  }

  // Read global config
  const globalConfig = await readJsonSafe(globalConfigPath)

  // Read project config
  const projectConfig = await readJsonSafe(join(cwd, '.telemachus', 'config.json'))

  // Deep merge: default -> global -> project (one-level deep for providerConfigs)
  const mergedProviderConfigs = mergeProviderConfigs(
    mergeProviderConfigs(DEFAULT_CONFIG.providerConfigs, globalConfig.providerConfigs),
    projectConfig.providerConfigs,
  )

  // Phase 18: merge mcpDefaults field-by-field (default -> global -> project).
  // mcpServers is replaced wholesale — the narrowest scope that sets it owns the list (D-04).
  const mergedMcpDefaults = {
    ...DEFAULT_CONFIG.mcpDefaults,
    ...globalConfig.mcpDefaults,
    ...projectConfig.mcpDefaults,
  }
  const rawMcpServers =
    projectConfig.mcpServers ?? globalConfig.mcpServers ?? DEFAULT_CONFIG.mcpServers

  // Expand ${VAR} / $VAR placeholders in mcpServers using process.env so
  // secrets stay in the shell env, not in the JSON file.
  const mergedMcpServers = rawMcpServers
    ? Object.fromEntries(
        Object.entries(rawMcpServers).map(([name, cfg]) => [name, expandMcpServerEnv(cfg)]),
      )
    : rawMcpServers

  const config: KristosConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    providerConfigs: mergedProviderConfigs,
    mcpDefaults: mergedMcpDefaults,
    mcpServers: mergedMcpServers,
  }

  // Phase 55: validate + clamp maxInflightLLMRequests.
  // Non-numeric or unparseable → fall back to default (4).
  // Out-of-range numbers → clamp to [1, 32] silently (ops-friendly; no crash).
  const rawMax = (projectConfig as any).maxInflightLLMRequests ?? (globalConfig as any).maxInflightLLMRequests
  if (rawMax === undefined) {
    config.maxInflightLLMRequests = DEFAULT_CONFIG.maxInflightLLMRequests
  } else if (typeof rawMax !== 'number' || Number.isNaN(rawMax)) {
    config.maxInflightLLMRequests = DEFAULT_CONFIG.maxInflightLLMRequests
  } else {
    const parsed = MaxInflightSchema.safeParse(Math.trunc(rawMax))
    if (parsed.success) {
      config.maxInflightLLMRequests = parsed.data
    } else {
      // Out of range — clamp rather than throw
      config.maxInflightLLMRequests = Math.max(1, Math.min(32, Math.trunc(rawMax)))
    }
  }

  // Phase 56 (TRUNC-01): validate discord.maxConversationTurns.
  // Out-of-range or non-integer → drop field so ConversationManager uses its default 40.
  if (config.discord?.maxConversationTurns !== undefined) {
    const parsed = MaxConversationTurnsSchema.safeParse(config.discord.maxConversationTurns)
    if (!parsed.success) {
      config.discord = { ...config.discord, maxConversationTurns: undefined }
    }
  }

  // Phase 56 (BUDGET-01): validate discord.dailyTokensPerUser.
  // Non-integer or out-of-range → drop field; runtime default 1_000_000 applies in DiscordTokenBudget.
  if (config.discord?.dailyTokensPerUser !== undefined) {
    const parsed = DailyTokensPerUserSchema.safeParse(config.discord.dailyTokensPerUser)
    if (!parsed.success) {
      config.discord = { ...config.discord, dailyTokensPerUser: undefined }
    }
  }

  // Phase 60 (DISPATCH-08): validate discord.autoDispatch.
  // Invalid cancellationWindowMs bounds → drop whole autoDispatch block
  // (ops-safe default-off: we'd rather disable auto-dispatch than run with
  // a bad window value). On success, re-assigns the parsed value so the
  // .default(10000) on cancellationWindowMs materializes when absent.
  if (config.discord?.autoDispatch !== undefined) {
    const parsed = AutoDispatchSchema.safeParse(config.discord.autoDispatch)
    if (parsed.success) {
      config.discord = { ...config.discord, autoDispatch: parsed.data }
    } else {
      config.discord = { ...config.discord, autoDispatch: undefined }
    }
  }

  // Phase 64 (PERS-01): validate discord.personas.
  // Invalid shape (wrong type, too-long values, empty keys) → drop whole field.
  // DEFAULT_PERSONA from src/discord/persona.ts applies at runtime when absent.
  if (config.discord?.personas !== undefined) {
    const parsed = PersonasSchema.safeParse(config.discord.personas)
    if (parsed.success) {
      config.discord = { ...config.discord, personas: parsed.data }
    } else {
      config.discord = { ...config.discord, personas: undefined }
    }
  }

  // Phase 64 (PERS-02): validate discord.suppressEmoji.
  // Invalid shape → drop whole field. Default (absent / false) leaves emoji
  // behavior unchanged; only explicit true adds the suppression line.
  if (config.discord?.suppressEmoji !== undefined) {
    const parsed = SuppressEmojiSchema.safeParse(config.discord.suppressEmoji)
    if (parsed.success) {
      config.discord = { ...config.discord, suppressEmoji: parsed.data }
    } else {
      config.discord = { ...config.discord, suppressEmoji: undefined }
    }
  }

  // Apply env overrides
  if (process.env.ANTHROPIC_API_KEY) {
    config.providerConfigs = {
      ...config.providerConfigs,
      anthropic: {
        ...config.providerConfigs.anthropic,
        apiKey: process.env.ANTHROPIC_API_KEY,
      },
    }
  }

  if (process.env.OPENAI_API_KEY) {
    config.providerConfigs = {
      ...config.providerConfigs,
      'openai-compat': {
        ...config.providerConfigs['openai-compat'],
        apiKey: process.env.OPENAI_API_KEY,
        model: config.providerConfigs['openai-compat']?.model ?? config.model,
      },
    }
  }

  if (process.env.KC_MODEL) {
    config.model = process.env.KC_MODEL
  }

  if (process.env.KC_PROVIDER) {
    const provider = process.env.KC_PROVIDER
    if (provider === 'anthropic' || provider === 'openai-compat' || provider === 'llamacpp') {
      config.provider = provider
    }
  }

  // LLAMACPP_BASE_URL (public name) takes precedence; KC_LLAMACPP_BASE_URL
  // kept as fallback for backward compat with private installs.
  const llamaUrl = process.env.LLAMACPP_BASE_URL ?? process.env.KC_LLAMACPP_BASE_URL
  if (llamaUrl) {
    config.providerConfigs = {
      ...config.providerConfigs,
      llamacpp: {
        ...config.providerConfigs.llamacpp,
        model: config.providerConfigs.llamacpp?.model ?? config.model,
        baseURL: llamaUrl,
      },
    }
  }

  // STRIP-02: DISCORD_OWNER_ID env var → prepend to allowedUsers (additive).
  // Backward compat: config field still works if present; env var becomes the
  // primary owner (allowedUsers[0]) so ownerId extractions in index.ts pick it up.
  if (process.env.DISCORD_OWNER_ID && config.discord) {
    const envId = process.env.DISCORD_OWNER_ID
    const existing = config.discord.allowedUsers ?? []
    if (!existing.includes(envId)) {
      config.discord = {
        ...config.discord,
        allowedUsers: [envId, ...existing],
      }
    }
  }

  // STRIP-03: TELEGRAM_OWNER_CHAT_ID env var → override ownerChatId.
  // Single owner model — env var wins over config.json value if both set.
  if (process.env.TELEGRAM_OWNER_CHAT_ID && config.telegram) {
    config.telegram = {
      ...config.telegram,
      ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID,
    }
  }

  return config
}
