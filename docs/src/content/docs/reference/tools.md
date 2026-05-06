---
title: Built-in tools
description: The 12 tools every Telemachus session ships with.
---

Telemachus exposes 12 built-in tools to the model. MCP servers and skills can add more at startup.

| Tool | Description | Permission gate |
|------|-------------|-----------------|
| `bash` | Run shell commands with a timeout. Uses `sh` on Unix, `cmd` or `powershell` on Windows (via `KC_SHELL`). | Yes (ask, plan) |
| `file_read` | Read a file by absolute path. Returns text or a binary marker. | No |
| `file_write` | Write a file. Overwrites existing content. | Yes (ask, plan) |
| `file_edit` | Find-and-replace edits within an existing file. | Yes (ask, plan) |
| `grep` | Ripgrep search across files/dirs with glob filters. | No |
| `glob` | Glob-based file discovery. | No |
| `web_search` | Web search (provider-dependent). | No |
| `ask` | Ask the user a question mid-turn and wait for a reply. | No |
| `todo` | Persistent todo list within the session. | No |
| `task` | Spawn a subagent with isolated context — see [Subagents guide](/guides/subagents/). | Inherits parent mode |
| `worktree` | Manage git worktrees (create/remove/list) with live cwd mutation — see [Worktrees guide](/guides/worktrees/). | Yes (ask, plan) |

## Permission modes

| Mode | Behavior |
|------|----------|
| `yolo` | No prompts. All tools execute immediately. |
| `ask` (default) | Inline `y / n / a` prompt before `bash`, `file_write`, `file_edit`, and `worktree`. `a` = allow for the rest of the session. |
| `plan` | **Silently blocks** all write/exec tools. The agent proposes a plan instead. See [Plan mode guide](/guides/plan-mode/). |
| `readonly` | Silently denies all write/exec tools. |

Set per session:

```bash
tm --mode yolo
```

Or via env:

```bash
export KC_MODE=readonly
```

## MCP tools

Since v1.3, MCP servers are **opt-in and lazy**. Declare them in `~/.telemachus/config.json` under `mcpServers` — nothing loads by default. Lazy servers spawn on first tool call and die after 10 min idle; `eagerLoad: true` restores startup loading.

Tools appear alongside built-ins with a `mcp__<server>__<tool>` prefix. Failed servers are reported once to stderr and marked `dead` in `/mcp` status — they don't crash the agent. Every MCP tool defaults to the `dangerous` trust tier and triggers the strong permission prompt unless promoted in config.

See [MCP servers](/guides/mcp-servers/) for config details and the `/mcp` command reference.

## Skills

Any directory under `~/.claude/skills/` that contains a `SKILL.md` is exposed as a slash command. Type `/` + `Tab` to cycle through available skills.
