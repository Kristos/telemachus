---
title: Providers & models
description: Switching between Anthropic, OpenAI, local models, and any OpenAI-compatible API.
---

Telemachus speaks to two families of providers through two SDKs:

| SDK | Used for |
|-----|----------|
| `@anthropic-ai/sdk` | Native Claude with prompt caching (the `anthropic` entry only) |
| `openai` (compat) | **Everything else** — OpenAI, OpenRouter, DeepSeek, Groq, xAI, Ollama, LM Studio, llama.cpp, etc. |

Anything with a `baseURL` is treated as OpenAI-compatible. That means you can wire up essentially any provider that exposes a `/v1/chat/completions` endpoint.

## Configure

Edit `~/.telemachus/config.json` and add entries under `providerConfigs`. **The key name is arbitrary** — whatever you use is what shows up in the `/model` picker.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "providerConfigs": {
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "apiKey": "sk-ant-..."
    },
    "openai": {
      "model": "gpt-5",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-..."
    },
    "openrouter": {
      "model": "anthropic/claude-sonnet-4.6",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-..."
    },
    "deepseek": {
      "model": "deepseek-chat",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-..."
    },
    "groq": {
      "model": "llama-3.3-70b-versatile",
      "baseURL": "https://api.groq.com/openai/v1",
      "apiKey": "gsk_..."
    },
    "xai": {
      "model": "grok-2",
      "baseURL": "https://api.x.ai/v1",
      "apiKey": "xai-..."
    },
    "ollama": {
      "model": "qwen2.5-coder:14b",
      "baseURL": "http://localhost:11434/v1",
      "isOllama": true
    },
    "lmstudio": {
      "model": "your-local-model",
      "baseURL": "http://localhost:1234/v1"
    }
  }
}
```

### Field reference

| Key | Required | Purpose |
|-----|----------|---------|
| `model` | ✅ | Default model name for this provider |
| `apiKey` | usually | Required for paid APIs, omitted for local models |
| `baseURL` | for non-Anthropic | OpenAI-compat endpoint. Omit for the `anthropic` entry. |
| `temperature` | ❌ | Override per provider |
| `isOllama` | ❌ | Set `true` for Ollama to disable streaming when tools are present (workaround for Ollama compatibility bug) |

### Rules

- **Only the `anthropic` key** uses the native Anthropic SDK with prompt caching. Everything else goes through the OpenAI-compatible path.
- **Key names are free-form**: `work-openai`, `router-eu`, `personal-groq` all work. That's what shows in the picker.
- **Restart `tm` after editing** — config is read at startup.

## Environment overrides

API keys can come from env vars instead of config — env always wins.

| Variable | Overrides |
|----------|-----------|
| `ANTHROPIC_API_KEY` | `providerConfigs.anthropic.apiKey` |
| `OPENAI_API_KEY` | `providerConfigs.openai.apiKey` |
| `KC_PROVIDER` | active provider key |
| `KC_MODEL` | active model |

## Profile-driven routing (v1.7+)

Profiles can override the provider and model for a session — no manual `/model` switching needed.

```json
{
  "profiles": {
    "cloud": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    },
    "local": {
      "provider": "llamacpp",
      "model": "GLM-4.7-Flash",
      "mcpServers": ["my-mcp-server"]
    }
  },
  "activeProfile": "cloud"
}
```

**At startup:** `activeProfile: "local"` launches `tm` using llamacpp — no `/model` command needed. If the profile specifies only `model` (no `provider`), the top-level provider is used with the profile's model.

**Mid-session:** `/profile local` reconstructs the provider and switches all subsequent turns to llamacpp. `/profile default` returns to top-level. Conversation history is preserved across switches.

**`/model` attribution:** When a profile overrides the provider, `/model` shows `llamacpp / GLM-4.7-Flash [profile: local]`. Without a profile override, it shows the top-level values as before.

**Agent jobs:** Each job specifies `provider`/`model` in its own config, resolved independently of the interactive profile.

See the [Configuration reference](/reference/configuration/) for the full `ProfileConfig` schema.

## Switching mid-session

Type `/model` inside `tm` to open the inline picker:

- **Arrow keys** navigate
- **Enter** selects
- **Esc** cancels

The sliding window and session continue — only the provider/model change. Live Ollama models discovered via `GET /api/tags` appear in a separate section below your configured providers. Selecting from the picker overrides any profile attribution.

## Prompt caching

When using Anthropic, Telemachus automatically sets the `cache_control` breakpoint on the system prompt and tool definitions so subsequent turns reuse cached tokens. You'll see the cached token count in the status bar.

## Built-in help

From inside `tm`, type `/help` to get a condensed version of this guide with the exact config snippets.
