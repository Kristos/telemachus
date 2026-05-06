---
title: MCP servers
description: Configure, introspect, and control Model Context Protocol servers in Telemachus.
---

Since v1.3, Telemachus treats MCP servers as **opt-in and lazy by default**. Startup stays fast and quiet, servers spawn only when the agent actually calls one of their tools, and their per-turn schema token cost is visible in `/cost`.

## Declaring servers

All MCP config lives in `~/.telemachus/config.json`. The legacy `~/.claude.json` auto-mount from v1.2 is gone.

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
      "trustTier": "risky",
      "toolOverrides": {
        "read_file": "safe"
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

### Per-server fields

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `command` | string | *required* | Executable to spawn (e.g. `npx`, `node`, `python`) |
| `args` | string[] | `[]` | Command arguments |
| `env` | object | `{}` | Environment variables for the child |
| `eagerLoad` | boolean | `false` | `true` → spawn at startup. `false` → lazy |
| `idleTimeoutMs` | number | `mcpDefaults.idleTimeoutMs` or `600000` | Idle kill threshold |
| `trustTier` | `"safe" \| "risky" \| "dangerous"` | `mcpDefaults.trustTier` or `"dangerous"` | Default tier for all tools from this server |
| `toolOverrides` | object | `{}` | Map of `toolName → tier` to override per tool |

### Global defaults

`mcpDefaults` sets server-level defaults. Per-server fields override. If you omit `mcpDefaults` entirely, Telemachus uses `idleTimeoutMs: 600000` and `trustTier: "dangerous"`.

## Lazy lifecycle

With no `eagerLoad`, a server's lifecycle looks like this:

1. **Startup:** registered but not spawned. `/mcp` shows `status: idle`.
2. **First tool call:** server spawns via `StdioClientTransport`, serves the request, the idle timer starts.
3. **Each subsequent call:** resets the idle timer on call start.
4. **After `idleTimeoutMs` of silence:** `SIGTERM` → 2 s grace → `SIGKILL`. Audit log records `mcp:<server>` with event `idle-kill`.
5. **Next tool call:** silent respawn. The agent doesn't notice.

If the spawn itself fails (missing binary, bad args, crashed immediately), the tool call returns an error and the server is marked `dead` in `/mcp`. There's no auto-retry — fix the config or use `/mcp spawn <name>` to try again.

## The `/mcp` command

Type `/mcp` at any time to see a table of every configured server:

```
name        | mode  | status | last activity | tools | trust
filesystem  | lazy  | alive  | 12s ago       | 8     | risky
github      | eager | alive  | 3m ago        | 14    | dangerous
slack       | lazy  | idle   | —             | 0     | dangerous
```

**Subcommands** (all session-scoped — they never edit `~/.telemachus/config.json`):

- `/mcp enable <name>` — re-enable a server you disabled this session.
- `/mcp disable <name>` — stop dispatching to this server for the rest of the session.
- `/mcp spawn <name>` — force-spawn a lazy server without waiting for a tool call. Useful for testing.
- `/mcp kill <name>` — terminate a live lazy server. Next call respawns it.

## Trust tiers

MCP tools default to `dangerous` so unknown servers trigger the strong permission prompt. Promote explicitly:

- **Server-level:** `"trustTier": "safe"` on the server entry applies to every tool from that server.
- **Per tool:** `"toolOverrides": { "read_file": "safe", "write_file": "risky" }` picks individual tools.

There is no implicit promotion. A server you never configured a tier for stays `dangerous`, even if every other server is `safe`.

## Observing schema cost

Every MCP tool sent to the model costs context tokens for its JSON schema. Run `/cost` to see the breakdown:

```
Session usage:
  total: 12450↑ 3280↓  $0.0421
  turns: 5

Tool schemas (last turn):
  builtin:       412 tok
  mcp:          1860 tok total
    mcp/filesystem:  340 tok
    mcp/github:     1520 tok
  (schema tokens estimated via gpt-tokenizer; relative, not exact billing)
```

Numbers are relative — they're good for spotting which MCP server is eating your context, not for billing. A server with a 1500-token schema is probably worth pruning before one with 200.

## What MCP does NOT protect

- **MCP children bypass the macOS bash sandbox.** The Phase 17 `sandbox-exec` wrapper covers the built-in `bash` tool only. An MCP server runs with your full user privileges — it can reach the network, touch any file you can touch, and spawn its own subprocesses. Only install servers you trust.
- **`/mcp kill` and `/mcp disable` don't yet write audit events** (only idle-kill does). Planned for v1.4.

## Related

- [Security guide](/guides/security/) — trust tiers, audit log, sandbox
- [Configuration reference](/reference/configuration/)
- [Built-in tools reference](/reference/tools/)
