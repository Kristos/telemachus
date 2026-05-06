---
title: Hooks
description: Run arbitrary shell commands before/after tool calls and on session stop.
---

Hooks are shell commands that fire in response to agent events. Telemachus supports three event types, configured the same way as [Claude Code hooks](https://code.claude.com/docs/en/hooks).

## Configure

Hooks live in `~/.claude.json` — the same file Telemachus already reads for MCP servers. No duplicate config.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|file_write|file_edit",
        "hooks": [
          { "type": "command", "command": "/usr/local/bin/audit-log.sh", "timeout": 5000 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "file_write|file_edit",
        "hooks": [
          { "type": "command", "command": "prettier --write $KC_TOOL_INPUT_PATH" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "echo 'session done' | notify-send" }
        ]
      }
    ]
  }
}
```

## Event types

| Event | Fires | Can block |
|-------|-------|-----------|
| `PreToolUse` | Before a tool executes | **Yes** — exit non-zero to cancel the tool call |
| `PostToolUse` | After a tool completes | No — exit code is logged as a dim warning |
| `Stop` | When the session ends | No |

## Matchers

The `matcher` field is a pipe-separated list of tool names (or `*` for all tools). A hook fires only when the active tool matches.

Examples:
- `"bash"` — only `bash` tool calls
- `"bash|file_write|file_edit"` — any write/exec tool
- `"*"` — every tool call

## Timeout

Default `30000` ms (30 s). Override per hook with `"timeout": <ms>`. Hooks that exceed the timeout are killed and logged.

## Failure handling

Failed hooks (non-zero exit or timeout) print a dim warning to stderr but **do not crash the session**:

```
[hook:PreToolUse:bash] exit 1: audit-log.sh: permission denied
```

The only exception is `PreToolUse` exit non-zero, which **blocks** the tool call — the agent sees a tool error and decides what to do next.

## Available context (via env vars)

Hook commands receive these environment variables:

| Variable | Description |
|----------|-------------|
| `KC_EVENT` | `PreToolUse`, `PostToolUse`, or `Stop` |
| `KC_TOOL_NAME` | The tool being called (empty for `Stop`) |
| `KC_TOOL_INPUT_JSON` | JSON-encoded tool input |

## Shared with Claude Code

Since both read `~/.claude.json`, **hooks configured for Claude Code will fire in Telemachus too** (and vice versa). Keep that in mind if you have side-effecting hooks.
