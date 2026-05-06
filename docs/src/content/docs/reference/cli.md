---
title: CLI commands
description: Flags and slash commands reference.
---

## Flags

| Flag | Description |
|------|-------------|
| `-r`, `--resume` | Open the session picker (auto-resumes if only one session) |
| `-s <id>`, `--session <id>` | Resume a specific session by UUID prefix |
| `--mode <mode>` | Override permission mode: `yolo` / `ask` / `readonly` |

### Examples

```bash
tm                                # new session
tm -r                             # pick a session to resume
tm --session 16b00ed9             # resume by UUID prefix
tm --mode yolo                    # no permission prompts this session
```

## Slash commands

| Command | Action |
|---------|--------|
| `/compact` | Shows a preview of the summary, lets you cancel, then replaces history with `[summary + last 3 turns]`. Blocked mid-tool-call. |
| `/model` | Open an inline picker to switch provider/model mid-session. Arrow keys + Enter. |
| `/clear` | Wipe the conversation to system-prompt-only and reset status bar counters. |
| `/plan` | Toggle [plan mode](/guides/plan-mode/) on/off mid-session. |
| `/cost` | Print token/cost breakdown with per-model totals. |
| `/resume` | Open the session picker inline (no restart). |
| `/export [file]` | Dump the current session as markdown to stdout (or a file if an arg is given). |
| `/mcp` | List mounted [MCP servers](/reference/configuration/#mcp-servers) and tool counts. |
| `/agents` | List available subagent types — see [Subagents guide](/guides/subagents/). |
| `/hooks` | List configured [hooks](/guides/hooks/). |
| `/<skill>` | Execute a skill from `~/.claude/skills/` (e.g. `/adapt`). Tab-complete to cycle. |

## Status bar

The live status bar at the bottom shows:

```
tokens in/out · session total · USD · ctx % · model · mode
```

- **tokens in/out** — last turn's usage
- **session total** — cumulative tokens since the session started
- **USD** — cumulative cost (using the active provider's pricing)
- **ctx %** — percent of the model's context window in use. Turns **amber at 75%** and **red at 90%**. Auto-triggers `/compact` at the configured threshold (default 90%).
- **model** — active provider/model
- **mode** — permission mode, color-coded (yolo=red, ask=yellow, plan=cyan, readonly=gray)
- **subagent…** — cyan pill appears while a subagent is running
