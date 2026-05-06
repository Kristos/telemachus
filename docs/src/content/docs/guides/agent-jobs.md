---
title: Agent Jobs (headless + scheduled)
description: Run tm as a short-lived autonomous process on a launchd schedule, with artifacts, webhooks, and profile-filtered tool surface.
---

`tm agent` is the headless side of Telemachus — it runs the same agent loop
that powers interactive sessions, but as a short-lived process with no TUI.
It's designed for scheduled jobs on a macOS machine: think "cron for LLM
workflows with real tool use, hard caps, and run artifacts you can audit."

Phase 24 (v1.5) shipped the launchd installer, so you can go from a JSON job
declaration to a scheduled autonomous agent in one command.

## Concepts at a glance

| Concept | Where it lives |
|---------|----------------|
| **Agent job** | Named entry under `agents.<name>` in `~/.telemachus/config.json` |
| **Profile** | `profiles.<name>` — MCP + CLI tool allowlist the job runs under |
| **Run artifacts** | `~/.telemachus/agent-runs/<name>/<ISO-timestamp>/` |
| **Schedule** | `agents.<name>.schedule` string — parsed at install time |
| **launchd plist** | `~/Library/LaunchAgents/com.telemachus.agent.<name>.plist` |

One agent job = one scheduled task = one plist = one audit trail. Multiple
jobs are independent — they don't share state beyond their config entry.

## The four subcommands

```
tm agent run <name>        — run the job once, right now, foreground
tm agent install <name>    — generate + load the launchd plist
tm agent uninstall <name>  — unload + delete the plist (keeps run history)
tm agent list              — show configured jobs merged with launchd state
tm agent status [name]     — browse past run artifacts
```

`install` is **idempotent-refresh**: editing the schedule in config.json and
re-running `tm agent install <name>` rewrites the plist and reloads launchd
in one step. No `--force` flag, no stale state.

`uninstall` **never touches `~/.telemachus/agent-runs/<name>/`** — run
history is evidence. If you want to wipe artifacts, do it manually.

## Minimum viable job

```json
{
  "provider": "llamacpp",
  "providerConfigs": {
    "llamacpp": {
      "model": "your-local-model.gguf",
      "baseURL": "http://localhost:8080/v1"
    }
  },
  "mcpServers": {
    "my-mcp-server": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["run", "/Users/you/projects/my-mcp-server/src/index.ts"],
      "env": { "MCP_TRANSPORT": "stdio" },
      "cwd": "/Users/you/projects/my-mcp-server",
      "eagerLoad": true,
      "trustTier": "risky"
    }
  },
  "agents": {
    "my-agent": {
      "prompt": "Use the my-mcp-server tools to fetch data. Write the first 5 results to result.md as Discord embed JSON.",
      "mcpServers": ["my-mcp-server"],
      "permissionMode": "agent",
      "schedule": "hourly",
      "maxIterations": 10,
      "maxWallClockMs": 600000,
      "maxTotalTokens": 200000,
      "output": {
        "type": "webhook",
        "url": "https://discord.com/api/webhooks/<id>/<token>",
        "format": "discord"
      }
    }
  }
}
```

Smoke-test before scheduling:

```
tm agent run my-agent
```

Then install:

```
tm agent install my-agent
tm agent list
```

## Schedule grammar

Three forms accepted at install time:

| Form | Fires |
|------|-------|
| `"hourly"` | Minute 0 of every hour |
| `"daily"` | 00:00 every day |
| `"cron: M H D M DoW"` | Integer values or comma-separated lists |

All times are **local time**. launchd honors the machine's timezone.

### Cron field rules

```
cron: MINUTE HOUR DAY-OF-MONTH MONTH DAY-OF-WEEK
        0-59  0-23    1-31     1-12    0-7 (0 and 7 both = Sun)
```

Allowed per field:

- `*` — any value
- a single integer — `8`
- a comma-separated list — `1,3,5`

**Not** supported (will throw at install time):

- Ranges: `1-5`
- Steps: `*/5`
- Named days: `MON`, `SAT`

### Examples

| Schedule | Meaning |
|----------|---------|
| `"hourly"` | Top of every hour |
| `"cron: 30 * * * *"` | 30 minutes past every hour |
| `"cron: 0 8 * * *"` | Every day at 08:00 |
| `"cron: 0 8 * * 1,3,5"` | Mon/Wed/Fri at 08:00 |
| `"cron: 0 8,17 * * *"` | Twice daily (08:00 and 17:00) |
| `"cron: 0 8,17 * * 1,3,5"` | Mon/Wed/Fri at 08:00 and 17:00 (6 fires/week — cartesian product) |
| `"cron: 0 9 1 * *"` | 1st of every month at 09:00 |

Comma lists in multiple fields produce a **cartesian product** of calendar
intervals. The plist renders these as `<array><dict>...</dict>...</array>`
and launchd fires the job whenever any of them matches.

### DST footgun

macOS launchd skips the 02:00 hour on spring-forward day and double-fires
near fall-back. If DST matters to your job, avoid hours 01–03. `hourly`
and `cron: 0 8,17 * * *` are both safe — the skipped/doubled fire is a
single hour, not the whole day.

## The locked plist shape

Phase 24 deliberately keeps the generated plist minimal. Generated keys:

| Key | Value |
|-----|-------|
| `Label` | `com.telemachus.agent.<name>` |
| `ProgramArguments` | `[<interpreter path>, <script path>, "agent", "run", "<name>"]` |
| `StartCalendarInterval` | one `<dict>` or an `<array>` of dicts |
| `EnvironmentVariables` | `PATH` = `$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` |

Explicitly **not** set (by design):

- `StandardOutPath` / `StandardErrorPath` — artifacts go to
  `~/.telemachus/agent-runs/<name>/<run>/log.txt`, not a shared file
- `WorkingDirectory` — inherits launchd default
- `RunAtLoad` — `tm agent install` never triggers an immediate run.
  Smoke-test with `tm agent run` manually first.
- `KeepAlive`, `ProcessType`, `ThrottleInterval` — not our use case

### The `tm` binary resolution gotcha

`bun link` installs `tm` as `~/.bun/bin/tm`, a symlink to the TypeScript
entry point `src/index.ts`. That file starts with `#!/usr/bin/env bun`.

`tm agent install` reads the shebang and bakes the absolute interpreter
path into `ProgramArguments`, so the plist looks like:

```xml
<array>
  <string>/Users/you/.bun/bin/bun</string>
  <string>/Users/you/projects/telemachus/src/index.ts</string>
  <string>agent</string>
  <string>run</string>
  <string>my-agent</string>
</array>
```

This means launchd does zero PATH lookups at fire time — the exec target
is unambiguous. If you move or reinstall `tm`, re-run `tm agent install <name>`
so the plist picks up the new path.

## Writing a job prompt

An agent job's `prompt` is the entire user message the model sees on run
start. Keep these constraints in mind:

- **The model has all the tools in the profile's allowlist.** They appear
  as `mcp__<server>__<tool>` names.
- **The model can only see the prompt and its own tool responses** — no
  conversation history, no session state, no filesystem context. Every
  run starts fresh.
- **Output goes to `result.md`** — whatever the final assistant message is
  gets written there and also passed to the webhook (if configured).
- **Be explicit about tool use.** Local models (small Qwen, Llama variants) will
  happily skip tool calls and hallucinate if the prompt sounds optional.
  Say: *"Your first action must be X. Call it ONCE. Take the result. Write
  result.md. Done."*
- **Hard caps stop runaway loops.** If the model blows `maxTotalTokens`
  it exits `max_total_tokens` and the webhook still fires with that
  exit_reason.

### Good prompt shape for local models

```
You are a [specific role]. Your job is [one sentence].

DO NOT make up data. Every value you write MUST come from a tool call.

Procedure:
1. Call <exact mcp tool name> ONCE with {<exact params>}.
2. [one or two deterministic steps over the returned data]
3. Write result.md as this exact JSON shape, filling fields from the
   tool responses (no prose, no explanation):

{...JSON skeleton with <placeholders>...}

If the tool returns zero items: write {...fallback JSON...}

Budget: N turns max. M tool calls. One file write. Done.
```

### Bad prompt shape (causes hallucination)

```
You can use my-mcp-server tools to find items. Consider calling get_latest.
Then produce a nice summary of the best 5 results.
```

The model will happily produce "a nice summary" entirely from its training
data and never touch the tools.

### Anti-hallucination: force literal field copy

A local model will happily call a tool, ignore the response, and invent
plausible data that matches what it thinks you want. Dogfood caught this
in the wild: `get_ending_soon` returned nine iPads and chairs, and the
model emitted five imaginary BMWs and Volvos with fake URLs.

To block this:

1. **Show a worked example** of tool-response → output in the prompt.
   Literal string-level, not abstract.
2. **List the exact source fields** the model must copy (e.g.
   `name ← item.title`, `value ← item.current_price + " SEK — " + item.end_time`).
3. **Add explicit hard rules**: "If the tool returns iPads and chairs,
   your output must contain iPads and chairs, NOT BMWs or Volvos."
4. **Forbid URL fabrication**: "Only emit URLs that appeared byte-for-byte
   in the tool response."

Local models are stochastic and will sometimes hallucinate regardless.
Cross-check with the actual MCP tool output (or a direct sqlite query
if the MCP backs a database) before trusting agent results in production.

## Profiles: narrowing the tool surface

A job's `profile` field references `profiles.<name>`, which has:

- `mcpServers: []` — **exact** MCP server allowlist (names from `mcpServers` map)
- `cliTools: []` — CLI tool allowlist (names from `cliTools` map, if any)

If `mcpServers` is an empty array, the job gets **zero** MCP tools. If
`cliTools` is empty, no CLI tools (bash stays available as a builtin
unless the permission mode blocks it).

When omitted, the job inherits the top-level config's full tool surface.
For scheduled jobs you almost always want a narrow profile — otherwise
the model sees every MCP and CLI tool on the box, and the schema budget
balloons.

## Run artifacts

Each run writes a timestamped directory:

```
~/.telemachus/agent-runs/<name>/
├── 2026-04-09T08-00-00Z/
│   ├── config.json       # snapshot of the job config at run time
│   ├── log.txt           # stdout+stderr tee (includes [mcp] load line)
│   ├── result.md         # final assistant message
│   ├── usage.json        # turn_count, duration_ms, exit_reason, error
│   └── webhook.json      # what was POSTed + HTTP status (if configured)
└── latest -> 2026-04-09T08-00-00Z/
```

Browse with `tm agent status <name>` — read-only, fast even with
hundreds of runs.

## Webhook output

`output: { type: "webhook", url, format }` POSTs `result.md` to any
HTTP endpoint. Formats:

| Format | Shape |
|--------|-------|
| `raw` | JSON body = `{ content: <result.md> }` |
| `discord` | Discord webhook embed shape |
| `slack` | Slack incoming webhook blocks shape |
| `ntfy` | ntfy.sh title + body |

**The webhook fires on success AND failure.** Success uses green
(`#2ecc71`), cap hits use orange (`#f39c12`), real errors use red
(`#e74c3c`). The `exit_reason` is in the payload. This means a silent
scheduled failure is impossible — you'll see either a useful result or
a clearly-labeled failure ping.

Webhook POST failures are written to `log.txt` but **don't** mark the
run itself as failed — the LLM work succeeded even if the notification
didn't land. Failed webhooks surface in `tm agent status`.

## Worked example: 3x/week scheduled search

Here's a worked example showing a scheduled search job that uses an MCP
tool, sends webhook notifications, and runs on a local model. Mon/Wed/Fri
at 08:00 local time.

```json
"scheduled-search": {
  "prompt": "Search for items matching <criteria> using the my-mcp-server tools. Filter by price and quality. Send any matches to the webhook.",
  "provider": "llamacpp",
  "model": "your-local-model.gguf",
  "mcpServers": ["my-mcp-server"],
  "permissionMode": "agent",
  "maxIterations": 60,
  "maxWallClockMs": 1800000,
  "maxTotalTokens": 500000,
  "schedule": "cron: 0 8 * * 1,3,5",
  "output": {
    "type": "webhook",
    "url": "https://discord.com/api/webhooks/...",
    "format": "discord"
  }
}
```

Install:

```
tm agent install scheduled-search
tm agent list
```

Expected `tm agent list` output:

```
NAME              SCHEDULE             INSTALLED  LOADED  NEXT FIRE  RUNNING
----------------  -------------------  ---------  ------  ---------  -------
scheduled-search  cron: 0 8 * * 1,3,5  y          y       ?          n
```

The `cron: 0 8 * * 1,3,5` expands into three `StartCalendarInterval` dicts
in the plist — one each for Weekday 1, 3, and 5 — so launchd fires the
job three times a week.

To change the search criteria, edit the `prompt` field in
`~/.telemachus/config.json`. No reinstall needed — the next scheduled
run reads the config fresh.

To change the schedule (e.g. from 3x/week to 5x/week), edit
`agents.scheduled-search.schedule` and re-run `tm agent install scheduled-search` — the
idempotent-refresh replaces the plist in place.

To stop it entirely:

```
tm agent uninstall scheduled-search
```

Run history in `~/.telemachus/agent-runs/scheduled-search/` is preserved.

## Debugging a failing job

1. **First, smoke-test with `tm agent run <name>`** — surfaces errors
   immediately in the foreground instead of waiting for a scheduled fire.
2. **Check `~/.telemachus/agent-runs/<name>/latest/log.txt`** — should
   contain `[mcp] loaded: N eager, M lazy` near the top. If that line is
   missing, MCP servers didn't load at all.
3. **If log.txt has `[mcp] <server> eager spawn failed: ...`** — the MCP
   server crashed on startup. Run its command directly (e.g.
   `bun run .../server.ts`) to see the underlying error.
4. **If `usage.json` shows `exit_reason: "max_total_tokens"`** — your
   prompt is letting the model loop. Tighten it. Force a small number
   of tool calls. Reduce the tool count via profile.
5. **If `result.md` is prose instead of the JSON you asked for** — local
   models often skip tool use when the prompt is soft. Rewrite the first
   sentence as a literal imperative: *"Your first action must be X."*
6. **If `tm agent list` shows `loaded: n`** — launchd rejected the plist.
   Usually PATH or permissions. Check `launchctl error` with the exit
   code from the install command.

## Pattern: persistent data source + short-lived stdio client

Some MCP servers host data that needs to be refreshed on a schedule
(scrapers, crawlers, aggregators). If `tm agent run <job>` spawns a
fresh stdio instance per run, the server's internal cron/timer doesn't
get time to refresh anything — every run queries an empty or stale
database.

The solution is to split roles:

1. **Persistent scraper process** — a long-running launchd service that
   runs the MCP server in a "refresh only, no transport" mode. It holds
   cron jobs alive and writes into a shared sqlite (or other) store.
2. **Short-lived stdio clients** — the `tm agent run` flow spawns the
   same server in `MCP_TRANSPORT=stdio` mode, which connects to the
   shared store as a read-only consumer, answers the tool call, and
   exits.

Both instances read the same file on disk. sqlite handles concurrent
readers; your MCP just needs a flag-gated branch that starts the cron
manager and skips every transport.

**Example plist for a persistent scraper** (separate from the `tm agent`
plist — this one runs your MCP server's scraper loop, not an agent job):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.telemachus.my-mcp-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/you/projects/my-mcp-server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/projects/my-mcp-server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/you/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>MCP_TRANSPORT</key>
    <string>stdio</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/my-mcp-server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/my-mcp-server.log</string>
</dict>
</plist>
```

`KeepAlive` makes launchd respawn it on crash. `ThrottleInterval=30`
prevents respawn storms. `RunAtLoad` fires it once at bootstrap time.

Load with modern launchctl verbs:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.telemachus.my-mcp-server.plist
launchctl print   gui/$(id -u)/com.telemachus.my-mcp-server | grep -E "state|last exit"
```

Unload with the matching `bootout`.

**Why this isn't a `tm agent install`** — `tm agent install` is for
scheduled agent runs (LLM jobs with artifacts, caps, webhooks). The
persistent scraper is infrastructure the agent depends on, not an agent
itself. Hand-rolled plist, not a tm construct.

## Hard caps as safety net

Every agent job has three hard caps enforced at each loop iteration:

| Cap | Default | What it protects against |
|-----|---------|--------------------------|
| `maxIterations` | 20 | Runaway tool-call loops |
| `maxWallClockMs` | 600000 (10 min) | Stuck HTTP calls, hung tools |
| `maxTotalTokens` | 100000 | Cost / rate-limit blowouts |

Hitting any cap writes a partial artifact directory and exits with
`exit_reason` = `max_iterations` / `max_wall_clock` / `max_total_tokens`.
The webhook still fires with the cap-hit shape (orange). You always
know a run happened and you always know why it stopped.

Raise them per-job — local models are slower per step, so a complex
search job might use 60 iterations / 30 min / 500k tokens. Anthropic or a fast local
model can stay closer to defaults.

## See also

- [Profiles](/reference/configuration#profiles) — narrowing the tool surface
- [MCP servers](/guides/mcp-servers/) — how tm loads and filters MCP tools
- [CLI reference: `tm agent`](/reference/cli/#tm-agent)
