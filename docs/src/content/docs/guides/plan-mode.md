---
title: Plan mode
description: Have the agent propose an implementation plan before touching code.
---

Plan mode is a permission mode that lets the agent read, search, and think — but **silently blocks all write and exec tools**. The agent responds with a structured plan that you can review, edit, or approve before any changes happen.

## Enable

### From the CLI

```bash
tm --mode plan
```

### From the environment

```bash
export KC_MODE=plan
tm
```

### Mid-session

Type `/plan` to toggle plan mode on/off without restarting. The status bar turns **cyan** while plan mode is active.

## What's blocked

All tools that mutate state:

- `bash`
- `file_write`
- `file_edit`
- `task` (subagents inherit plan mode)
- `worktree` (create/remove)

Read-only tools remain available:

- `file_read`
- `grep`
- `glob`
- `web_search`
- `todo`
- `ask`

## What the agent does

When plan mode is active, the system prompt gains an instruction telling the agent to **propose a plan instead of executing**. The agent will:

1. Read relevant files
2. Search the codebase for context
3. Output a structured markdown plan:
   - Goal
   - Files to change
   - Approach
   - Risks
4. Wait for your approval

When you're ready, toggle off with `/plan` and type "go" (or edit the plan and proceed).

## Tip: combine with subagents

Run a subagent in plan mode by passing `--mode plan` at launch — the child inherits the mode. Useful for brainstorming without polluting the parent's context.
