---
title: Sessions & persistence
description: How Telemachus saves and resumes conversations.
---

Every `tm` run is a session. Sessions are saved automatically to `~/.telemachus/sessions/{uuid}.jsonl`.

## Where sessions live

```
~/.telemachus/
├── config.json
└── sessions/
    ├── 16b00ed9-d514-4a2c-9f32-...jsonl
    └── ...
```

Each line in the JSONL file is one event: a user message, an assistant message, a tool call, a tool result, or a usage record. Writes are atomic (tmp → `fdatasync` → rename) so a crash mid-turn never corrupts the file.

## Resume the last session

```bash
tm -r
```

Opens a picker sorted by most recent. Arrow keys navigate, Enter selects. If there's only one session, it resumes immediately.

## Resume a specific session

```bash
tm --session 16b00ed9-d514-4a2c-9f32-abc123
```

You only need the prefix — Telemachus matches the first unique session ID.

## Sliding window

Telemachus caps the active context at `slidingWindow` messages (default 50). Older messages are dropped **orphan-safely** — if a `tool_use` would be separated from its matching `tool_result`, the window is extended backward to keep them together. This prevents the API errors you get when tool pairs are severed.

## /compact

When you want to reset the context but keep the gist, run `/compact`. Telemachus calls the current provider to summarise the conversation in one shot, replaces the history with `[summary + last 3 turns]`, and prints the token count before and after.

`/compact` is blocked while a tool call is in progress so you don't lose mid-flight work.

## /clear

`/clear` wipes the conversation back to system-prompt-only and resets the status bar counters. Useful when switching tasks.
