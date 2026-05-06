---
title: Subagents
description: Spawn sub-loops with isolated context using the task tool.
---

Telemachus can spawn **subagents** — independent agent loops that run in their own context window, execute a focused task, and return a result to the parent. This is the `task` built-in tool, modeled after Claude Code's `Task`.

## Why subagents?

- **Context isolation** — the parent session doesn't accumulate research tokens from one-off lookups
- **Parallel reasoning** — hand off an investigation and continue your main thread
- **Specialized prompts** — a subagent can be given a narrow role ("find bugs in auth.ts") without polluting the parent system prompt

## Usage

Subagents are invoked through the `task` tool, which the model calls on your behalf. You don't need to call it manually — just ask for something that benefits from isolation:

```
> search the whole repo for any place we forget to await a promise, summarise findings
```

The model calls `task` with a description and prompt. The parent's status bar shows a cyan `subagent…` indicator while the child loop runs.

## How it works

1. Parent loop calls `task({ description, prompt, subagent_type? })`
2. `runSubagent()` creates a fresh message array with just the subagent's prompt
3. Subagent inherits the parent's provider, model, and tool registry
4. Subagent runs to completion (no streaming back to parent)
5. Final text is returned to the parent as the tool result

## Permission inheritance

Subagent tool calls respect the **same permission mode as the parent**. If you're in `ask` mode, the subagent will prompt you for bash / file write approvals. In `plan` mode, the subagent is also restricted.

## Current limitations (v1.2)

- **Single level** — subagents cannot spawn their own subagents (nested recursion deferred)
- **No streaming** — parent sees only the final result, not intermediate steps
- **subagent_type is informational** — there's no type-based routing yet; all subagents share the same tool registry

## Status bar indicator

While a subagent runs, the parent's status bar shows a cyan `subagent…` pill. It clears automatically when the child loop finishes, even if the subagent throws.
