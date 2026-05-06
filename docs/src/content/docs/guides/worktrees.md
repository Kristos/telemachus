---
title: Worktrees
description: Create, remove, and list git worktrees from inside the agent.
---

Telemachus ships a built-in `worktree` tool that wraps `git worktree` and mutates the session's working directory live — so subsequent tool calls automatically target the new worktree.

## Actions

| Action | Description |
|--------|-------------|
| `create` | Add a new worktree and switch the session's cwd to it |
| `remove` | Remove a worktree (restores original cwd) — refuses if dirty unless `force: true` |
| `list` | List all worktrees on the repo |

## Example prompts

```
> create a worktree for branch bugfix/memory-leak and switch to it
```

```
> list all worktrees
```

```
> we're done here — remove this worktree
```

The model calls the `worktree` tool on your behalf; you don't need to invoke it manually.

## How cwd switching works

Telemachus's `ToolContext` holds a `cwdRef` — a get/set closure over the session's live cwd. When the worktree tool creates a new tree, it calls `cwdRef.set(newPath)`, and every subsequent tool call reads the updated value. No restart needed.

When a worktree is removed, `cwdRef` is restored to the original cwd captured at session start.

## Dirty check

`worktree remove` refuses to delete a worktree with uncommitted changes:

```
Error: worktree has uncommitted changes — pass force=true to remove anyway
```

You can override with `force: true` if you're sure.

## Permissions

The `worktree` tool is treated as a write/exec tool. It requires approval in `ask` mode and is blocked in `plan` mode and `readonly` mode.
