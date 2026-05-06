---
title: Configuration
description: Config file schema and environment variables.
---

## Config file

`~/.telemachus/config.json` — auto-created on first run.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "windowSize": 40,
  "permissionMode": "ask",
  "temperature": 0.7,
  "maxIterations": 50,
  "toolTimeoutMs": 30000,
  "autoCompactThreshold": 90,
  "activeProfile": "default",
  "providerConfigs": {
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "apiKey": "sk-ant-..."
    },
    "llamacpp": {
      "model": "GLM-4.7-Flash",
      "baseURL": "http://windowsbox.tailnet-name.ts.net:8080/v1",
      "apiKey": "sk-rig"
    }
  },
  "profiles": {
    "default": {},
    "local": {
      "provider": "llamacpp",
      "model": "GLM-4.7-Flash",
      "mcpServers": ["filesystem"]
    }
  }
}
```

### Top-level fields

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `"anthropic"` | Active provider key (must match a key in `providerConfigs`) |
| `model` | string | `"claude-sonnet-4-6"` | Active model |
| `windowSize` | number | `40` | Max messages kept in sliding window (orphan-safe) |
| `permissionMode` | `"yolo" \| "ask" \| "plan" \| "readonly"` | `"ask"` | Default permission gate |
| `temperature` | number | `0.7` | Sampling temperature |
| `maxIterations` | number | `50` | Max agent loop iterations per turn |
| `toolTimeoutMs` | number | `30000` | Tool execution timeout |
| `autoCompactThreshold` | number | `90` | Context % at which `/compact` auto-triggers |
| `providerConfigs` | object | — | Map of provider key → `ProviderConfig` |
| `profiles` | object | — | Map of profile name → `ProfileConfig` (v1.4+) |
| `activeProfile` | string | — | Default profile to activate at startup (v1.4+) |

### `ProviderConfig` fields

| Key | Required | Description |
|-----|----------|-------------|
| `model` | yes | Default model name for this provider |
| `apiKey` | usually | API key for paid providers. Can also come from env vars. |
| `baseURL` | non-Anthropic | OpenAI-compatible endpoint. Omit for the `anthropic` key. |
| `temperature` | no | Override per provider |
| `isOllama` | no | Set `true` for Ollama compatibility workaround |

### `ProfileConfig` fields (v1.4+, routing v1.7+)

Profiles control which tools are visible and which provider/model the session uses.

| Key | Type | Description |
|-----|------|-------------|
| `mcpServers` | `string[]` | MCP server names to include (omit = all servers) |
| `cliTools` | `string[]` | CLI tool names to include (omit = all tools) |
| `provider` | string | Override top-level `provider` when this profile is active (v1.7+) |
| `model` | string | Override top-level `model` when this profile is active (v1.7+) |
| `permissionMode` | string | Override permission mode |

**Provider routing (v1.7):** When a profile specifies `provider` and/or `model`, activating it overrides the top-level config for the session. If only `model` is set, the top-level provider is used with the profile's model. If neither is set, the top-level provider/model are used unchanged.

```json
{
  "profiles": {
    "local": {
      "provider": "llamacpp",
      "model": "GLM-4.7-Flash",
      "mcpServers": ["my-mcp-server"]
    }
  }
}
```

Activate via `--profile local` on the CLI, `activeProfile` in config, or `/profile local` mid-session. See the [Providers guide](/guides/providers/) for details.

## Environment variables

| Variable | Overrides |
|----------|-----------|
| `ANTHROPIC_API_KEY` | `providerConfigs.anthropic.apiKey` |
| `OPENAI_API_KEY` | `providerConfigs.openai.apiKey` |
| `KC_PROVIDER` | `provider` |
| `KC_MODEL` | `model` |
| `KC_MODE` | `permissionMode` |
| `KC_SHELL` | Windows bash-tool shell (`cmd` or `powershell`) |

## MCP servers

Since v1.3, MCP servers are **opt-in and lazy by default**. Since v1.6, MCP children are **sandboxed on macOS** with per-server scope control.

```json
{
  "mcpDefaults": {
    "idleTimeoutMs": 600000,
    "trustTier": "dangerous"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "eagerLoad": false,
      "trustTier": "safe",
      "toolOverrides": { "read_file": "safe" },
      "sandbox": {
        "network": true,
        "paths": ["~/Documents", "~/projects"]
      }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "eagerLoad": true
    }
  }
}
```

### MCP server fields

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `command` | string | required | Command to spawn the server |
| `args` | `string[]` | `[]` | Arguments passed to the command |
| `env` | object | — | Environment variables for the server process |
| `cwd` | string | — | Working directory for the server process |
| `eagerLoad` | boolean | `false` | `true` = spawn at startup; `false` = lazy spawn on first tool call |
| `trustTier` | `"safe" \| "risky" \| "dangerous"` | `"dangerous"` | Trust tier for all tools from this server |
| `toolOverrides` | object | — | Per-tool trust tier overrides (tool name → tier) |
| `idleTimeoutMs` | number | `600000` | Kill the server after this many ms of inactivity |
| `sandbox` | object | — | **v1.6+** macOS sandbox scope overrides (see below) |

### `sandbox` sub-config (v1.6+, macOS only)

Controls the `sandbox-exec` scope for this MCP server's child process.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `network` | boolean | `false` | Allow outbound network. Only honored for `safe` tier — `risky` and `dangerous` always get network denied regardless. |
| `paths` | `string[]` | `[]` | Additional read-write filesystem paths beyond cwd + tmpdir. Each entry is `~`-expanded and resolved via `realpathSync`. Unresolvable entries are dropped with a stderr warning. |

The sandbox always grants cwd + tmpdir. `sandbox.paths` adds extra directories. All granted paths are read-write. No glob patterns, no read-only mode.

See the [Security guide](/guides/security/) for the full sandbox details.

## Agent jobs (v1.5+)

Agent jobs run the same agent loop headlessly on a launchd schedule.

```json
{
  "agents": {
    "nightly-job": {
      "prompt": "Call get_ending_soon and format as Discord embed...",
      "provider": "llamacpp",
      "model": "GLM-4.7-Flash",
      "profile": "nightly-job",
      "permissionMode": "agent",
      "maxIterations": 20,
      "maxWallClockMs": 600000,
      "maxTotalTokens": 200000,
      "schedule": "hourly",
      "output": {
        "type": "webhook",
        "url": "https://discord.com/api/webhooks/...",
        "format": "discord"
      }
    }
  }
}
```

See the [Agent jobs guide](/guides/agent-jobs/) for the full reference.

## Skills

Any directory under `~/.claude/skills/` containing `SKILL.md` is loaded as a slash command.
