---
title: Security
description: What Telemachus's trust tiers, audit log, and sandbox actually do — and don't.
---

Telemachus is a personal coding agent that can run shell commands, read files, call MCP servers, and talk to the network. v1.3 introduced hardening, v1.6 extended it to MCP children, v1.7 added profile-driven provider routing. This page says plainly what's enforced and what isn't.

## Threat model

Telemachus assumes the agent driver (cloud API or local LLM) can be adversarial — a prompt injection, a malicious MCP server description, or simply a confused local model. The goal is to keep one confused call from being catastrophic. The goal is **not** to resist a targeted attacker who already has code execution on your machine.

## Trust tiers

Every tool is classified into one of three tiers, enforced at the permission prompt:

| Tier | Meaning | Prompt behavior |
|------|---------|-----------------|
| `safe` | Read-only, scoped to workspace. Always allowed. | No prompt in `ask` or `readonly` |
| `risky` | Side effects, but bounded (writes within cwd, network reads) | Prompts once per session in `ask` mode |
| `dangerous` | Arbitrary side effects (bash, destructive writes, MCP tools by default) | Strong prompt every time in `ask` mode |

- Unknown tools fall through to `dangerous` (fail-closed).
- MCP tools start at `dangerous` via a dedicated override registry — promote explicitly in `~/.telemachus/config.json`. See the [MCP servers guide](/guides/mcp-servers/).

## Audit log

Every tool call and MCP lifecycle event appends one JSON line to `~/.telemachus/audit/<YYYY-MM-DD>.jsonl`. Since v1.6, entries carry a `kind` discriminator:

### Tool call entries

```json
{
  "kind": "tool_call",
  "ts": "2026-04-09T14:23:01.412Z",
  "sessionId": "01JX...",
  "tool": "bash",
  "tier": "dangerous",
  "argsHash": "sha256:…",
  "resultSize": 2048,
  "durationMs": 312,
  "mode": "ask",
  "exitCode": 0,
  "sandbox": "enforced",
  "platform": "darwin"
}
```

### MCP lifecycle entries (v1.6+)

Every MCP server's lifecycle is reconstructable from the audit log alone:

```json
{"kind": "mcp_spawn", "ts": "...", "sessionId": "...", "server": "my-mcp-server", "pid": 58278, "tier": "risky", "sandbox": "enforced"}
{"kind": "mcp_kill", "ts": "...", "sessionId": "...", "server": "my-mcp-server", "pid": 58278, "tier": "risky", "reason": "user"}
{"kind": "mcp_idle_kill", "ts": "...", "sessionId": "...", "server": "my-mcp-server", "pid": 58278, "tier": "risky", "idle_duration_ms": 600000}
{"kind": "mcp_disable", "ts": "...", "sessionId": "...", "server": "my-mcp-server", "previous_tier": "risky", "was_alive": true, "pid": 58278}
```

Query with `jq`:

```bash
# All MCP events today
cat ~/.telemachus/audit/$(date +%Y-%m-%d).jsonl | jq 'select(.kind | startswith("mcp_"))'

# Reconstruct one server's lifecycle
cat ~/.telemachus/audit/*.jsonl | jq 'select(.server == "my-mcp-server")'
```

- **Arguments are never stored.** Only a SHA-256 of the serialized args.
- **Daily rotation**, kept forever. Prune manually if it grows.
- Entries missing `kind` (from v1.3-v1.5 audit files) default to `tool_call` on read.

## macOS sandbox

On macOS, both **bash tool** and **MCP child subprocesses** run inside a `sandbox-exec` SBPL profile. The profile denies by default and allows only:

- Reads from anywhere (for tools like `grep`, `cat`, `find`)
- Writes to the current working directory
- Writes to a scoped tmpdir: `/private/tmp/tm-<sessionId>/`
- **No network** (by default)

### Bash sandbox

Opt into network for a single bash call with `network: true` — this surfaces a `[network]` prefix in the permission prompt.

In `yolo` mode, the sandbox is **bypassed entirely** with a visible `[sandbox: BYPASSED]` prefix and an audit log entry.

### MCP sandbox (v1.6+)

MCP child subprocesses are wrapped by the same `sandbox-exec` profile as bash. The sandbox scope is determined by the server's trust tier:

| Tier | Network | Filesystem |
|------|---------|------------|
| `dangerous` (default) | Denied | cwd + tmpdir only |
| `risky` | Denied | cwd + tmpdir only |
| `safe` | Denied by default; opt in with `sandbox.network: true` | cwd + tmpdir + `sandbox.paths` |

Configure per-server sandbox grants in `~/.telemachus/config.json`:

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "node",
      "args": ["server.js"],
      "trustTier": "safe",
      "sandbox": {
        "network": true,
        "paths": ["~/Documents", "~/projects"]
      }
    }
  }
}
```

- `sandbox.paths` entries are resolved with `~` expansion and `realpathSync`. Unresolvable paths are dropped with a stderr warning.
- All granted paths are **read-write** (matching how cwd is granted).
- The sandbox is applied transparently — MCP servers don't need to know they're sandboxed.

### Non-macOS platforms

On Linux and Windows, the first MCP spawn in a session prints one warning to stderr:

```
[mcp: sandbox unavailable on linux]
```

A matching `mcp_sandbox_warning` entry is written to the audit log. Subsequent spawns in the same session do not re-warn. Design docs for Linux (bwrap) and Windows (AppContainer) sandboxing exist — implementation is planned for a future milestone.

## What is NOT protected

Be explicit about the gaps:

- **Linux and Windows have no sandbox** for bash or MCP children. A one-time session warning fires and the audit log records `sandbox: "unavailable"`.
- **Other built-in tools (`write`, `edit`, `file_read`) are not sandboxed.** They write to cwd by design. The trust tier system still gates them at the permission prompt.
- **Yolo mode opts out of all of the above.** The audit log still records everything.
- **Prompt injection filtering is not attempted.** Telemachus's defense is architectural: sandbox the subprocess, audit everything, default-deny unknown tools.
- **No network-level egress filtering.** If a tool has network access, it can reach anywhere. There are no per-host allowlists.

## Related

- [MCP servers](/guides/mcp-servers/) — how trust tiers apply to MCP tools
- [Providers & models](/guides/providers/) — profile-driven provider routing
- [Configuration reference](/reference/configuration/)
- [Built-in tools reference](/reference/tools/)
