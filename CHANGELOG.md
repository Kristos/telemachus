# Changelog

All notable changes to Telemachus.

## [Unreleased]

### Added
- `KC_MEMORY.md` at repo root — shared memory slot for Claude Code and kc sessions (kc's Phase 46 loader reads this; Claude Code picks it up via its project-memory mechanism).
- **`!jobs` Discord command** ([#25](https://github.com/Kristos/telemachus/pull/25)): shows all configured agents with live launchd status (🟢 running with PID / ✅ idle / ⚠️ last exit code) and last run age + exit reason. Complements `!status` (historical runs) with real-time job health.
- **`web-search` MCP**: DuckDuckGo search + page fetch tools now available in all Discord and CLI sessions via your local MCP server directory. Natural language — "search for X", "fetch this URL" — now works without a browser.

### Fixed
- Post-v3.2 hotfix ([#10](https://github.com/Kristos/telemachus/pull/10)): orchestration engine now guarantees the repo root is a git repo (runs `git init` + empty initial commit if needed) before any worker creates a worktree. Closes the chicken-and-egg bug that killed the first live `!orchestrate` run on 2026-04-14 (init-project worker failed, wave fail-fast correctly caught it).
- Post-v3.2 hotfix: dependency validator timeout now scales with task count (`computeValidatorTimeoutMs` — 10s baseline + 2s/task above 5, capped at 45s). Was hardcoded 10s and timing out on plans ≥ 8 tasks.
- Post-v3.6 hotfix: Discord startup DM now shows correct version + short commit hash. `package.json` bumped 1.9.0 → 3.6.0; `git rev-parse` in `src/discord/index.ts` now runs with `cwd: repoRoot` so launchd-spawned bun can resolve the hash (was silently falling back to `"unknown"`).
- Post-v3.8 hotfix ([#21](https://github.com/Kristos/telemachus/pull/21)): agent-runner launchd jobs (`daily-summary`, `data-fetch`, `nightly-job`) no longer abort at the SAND-02 probe with `cwd resolves to fileroot '/'`. Root cause: Phase 62 fixed Discord's cwd='/' launch but agent-runner was missed. Two-layer fix mirrors the Discord solution — `run-job.ts` calls `initSandboxEnv()` before the probe (covers existing installs), and `renderPlist` now emits `<WorkingDirectory>` when the installer supplies one (derived by walking up from the kc script path to find `.git`).
- Post-v3.8 hotfix ([#22](https://github.com/Kristos/telemachus/pull/22)): daily DM no longer shows `Est. cost: N/A` for known models. `daily-dm.ts` now calls `resolveModelPricing`, which falls through to `PRICING_TABLE` when `config.discord.pricing` override isn't set. N/A is reserved for truly unknown models (Ollama, llamacpp GGUFs).
- Post-v3.8 hotfix ([#23](https://github.com/Kristos/telemachus/pull/23)): Discord `task` tool subagents no longer throw `RouterProvider requires opts.turnId`. Root cause: `turn-execution.ts` built the nested `toolContext.subagentParent` without propagating `turnId` / `routerSession`, so task-dispatched subagents hit the ROUTE-06 guard. Both fields now flow through — subagents inherit the parent's per-turn routing decision and contribute to classifier-token accounting.

## [v3.8 — P1 + P2 only] — 2026-04-20 — Self-Improving Agent (partial)

Shipped 2 of 3 v3.8 phases. P3 (Self-Improve Loop, Phase 68) deferred until v3.6 acceptance passes.

### Added

- **BLAST-01..03** (Phase 66, v3.8-P1): Orchestration blast-radius guard. New `blast_radius_exceeded` audit kind emitted with `{taskId, branch, fileCount, threshold}`. `OrchestrationRunConfig` gains `blastRadiusThreshold: z.number().int().min(1).default(20)` — configurable per-run; existing configs silently get the default. Pre-merge gate in `src/orchestration/engine.ts` counts files via `git diff --name-only HEAD..<branch>`; if over threshold, the task transitions to `escalated` instead of merged (branch left on disk for human review). Prerequisite for v3.8-P3 stability contract.
- **AGMEM-01..03** (Phase 67, v3.8-P2): Per-agent memory. `loadSharedContext({ agentName })` now reads `~/.telemachus/agent-memory/<agentName>/MEMORY.md` (via `os.homedir()`) and appends it after the global `KC_MEMORY.md`. Participates in existing token-budget warning. Headless agent-runner jobs thread their job name through as `agentName`; Discord entry passes `agentName: 'discord'`. CLI behavior unchanged when no agentName is provided. `/context` slash output lists per-agent memory file when loaded. Side benefit: closed a latent gap where headless agents were spawned with no system prompt at all.

### Deferred

- **Phase 68 (v3.8-P3) Self-Improve Loop** — scanner + `selfMode` flag + `kc orchestrate --self` CLI + nightly launchd scan. Depends on v3.6 OBS-01 audit patterns being trustworthy. Unblocks when v3.6 acceptance passes.

## [v3.6] — 2026-04-19 — SUCCESS-01 Remediation + Safety Net

5 phases (61-65), 25 plans, 30 requirements, ~149 commits. Closes v3.5 SUCCESS-01 cost failure (cost target missed by an order of magnitude) and retroactively closes SUCCESS-02a (Anthropic prompt caching was never wired); ships observability + sandbox + Discord hygiene safety net surfaced during the v3.5 post-mortem.

Milestone acceptance pending user offline verification of 24h Z.ai billing, SUCCESS-02a cache live, PERS-02 3-channel Discord, and Keychain setup.

### Added

- **COST-01..08** (Phase 61): Real Flash pricing in `PRICING_TABLE['glm-4.7-flash']` ($1.00/$1.50 per MTok empirical vs prior stub 0/0). `turn_summary.model` reflects actual routed sub-provider. `RouterConfig.classifierTimeoutMs` 2000ms regression-locked. `routerConfig.fallbacks.classifier` wired to FallbackProvider. `RouterClassifierBreaker` per-instance circuit breaker + `router_classifier_paused` audit kind. `Provider.countTokens` interface (Anthropic SDK `beta.messages.countTokens` + OpenAI-compat tokenizer + char/4 fallback). `ConversationManager.enforceTokenCap` (64k Flash / 128k glm-4.6 / 160k Sonnet). `turn_summary.contextSizeTokens` field.
- **SAND-01..05** (Phase 62): `write_todos` uses `os.homedir()` (was silently writing to `/.telemachus` with empty HOME per 999.14). `sandbox_probe` audit kind + startup probe in `runSubagent` + agent-runner + Discord entry points — fails loudly on unwritable HOME or non-project CWD. Repo-wide grep-assertion test locks zero `process.env.HOME` reads in `src/tools/`. `initSandboxEnv` helper threads explicit `HOME` + `KC_PROJECT_ROOT` into Discord subagent spawns. Glob `/dev/fd` `EBADF` fixed (three-layer defense in `src/tools/builtin/glob.ts`) — *not* deferred.
- **OBS-01..05** (Phase 63): New `tool_error` audit kind + `classifyError` helper + emission in `src/agent/loop.ts` on both throw and `result.isError` paths. Ring buffer metrics in `src/security/tool-error-metrics.ts` (bounded by count 1000 + age 1h). `createToolErrorAlertWatcher` factory: 3 failures/15m → DM owner, 30m cooldown. Daily summary DM extended with top-N failing tools section. `!tool-errors [15m|1h|24h]` Discord command.
- **PERS-01..03** (Phase 64): `DiscordConfig.personas: Record<channelId, string>` map with Zod validation. `DiscordConfig.suppressEmoji: Record<channelId, boolean>` flag. Default neutral-engineer persona when no channel override — stops auction-MCP hype tone from leaking into coding-help channels.
- **CACHE-01..04** (Phase 64): `attachSystemCache` helper wires `cache_control: { type: 'ephemeral' }` on Anthropic system prompt when above model-specific threshold (Sonnet 1024, Haiku 2048, Opus 1024). `maybeCacheToolsArray` attaches cache breakpoint to last tool definition. `TurnSummaryRecord.cacheReadTokens` + `cacheCreationTokens` persisted. `/cost` slash + `tm discord usage --breakdown` render cache metrics. Closes v3.5 SUCCESS-02a.
- **HYG-01..05** (Phase 65): `runner.ts` split 898 → 300 lines; extracted `message-intake.ts` (163), `turn-queue.ts` (98), `reply-writer.ts` (164), `error-boundary.ts` (111), `turn-execution.ts` (293) — all <400. `ChannelQueueLRU` class replaces unbounded Map (1h idle TTL, 5min sweep). `JsonlWriter` class unifies atomic-append across `token-budget.ts` + `usage-store.ts` + `turn-summary-store.ts`. macOS Keychain migration: `scripts/setup-keychain.sh` + `scripts/kc-discord-launcher.sh` + [`docs/keychain.md`](docs/keychain.md); plist references keychain with env-var fallback + stderr warning. Webhook server `Bun.spawn` calls wrapped in 300s `AbortController` (was unbounded).

### Fixed

- Phase 61-06 TDZ ReferenceError on `contextSizeTokens` in `src/discord/runner.ts` finally block (discovered during Phase 64 execution, bundled as Phase 65-01 Task 0 ahead of the runner split).
- `write_todos` tool silently failing with `EROFS` when `HOME=""` in launchd-spawned subagents (999.14). Now throws descriptive error.
- `glob` tool `EBADF` on `/dev/fd/N` paths when CWD was filesystem root (999.15 SAND-05).
- `turn_summary.model` hardcoded to profile base model instead of router-routed sub-provider (999.10 Issue B). `tm discord usage --breakdown` totals are now trustworthy.
- Prompt caching never wired in Anthropic CLI path (999.12) — `src/providers/anthropic.ts` now conditionally attaches `cache_control` to system + tools when above model-specific minimum token threshold.

### Research / process


## [v3.5] — 2026-04-18 to 2026-04-19 — Cost-Aware Routing (**FAILED acceptance**)

4 phases (57-60). Architectural work sound (RouterProvider, classifier, tool-result stripping, auto-dispatch) but milestone acceptance FAILED 2026-04-19: measured cost target was missed by an order of magnitude. SUCCESS-02a also FAILED (Anthropic prompt caching never wired). Remediation shipped as v3.6.

## [v3.2] — 2026-04-14 — Orchestration Robustness

3 phases (52-54), 7 plans, 35 commits. Prevent token-burning failure cascades in `!orchestrate` and give the chat agent context about completed runs.

### Added
- **DEP-01, DEP-02, DEP-03** Dependency validation pass (`validateDependencies`) — cheap-model reviewer flags suspicious missing `dependsOn` edges before plan approval. Rationale string per flag. Fail-soft (returns `[]` on validator error, never blocks orchestration). 10s → 45s timeout ladder (hotfixed post-release).
- **WAVE-01..04** Wave fail-fast gate in the engine dispatch loop. Calculates failure rate per `Promise.allSettled` batch; if `>=` threshold (default 0.5, `1.0` disables), pauses and invokes a transport-agnostic callback for `continue` / `abort` / `inspect`. CLI readline prompt + Discord channel-reply prompt with 5-min timeout defaulting to abort. Audit entry `wave_fail_fast` per trigger.
- **CHAT-01..03** Chat context continuity — orchestration completion (success OR catastrophic failure) appends a structured assistant turn `"Orchestration [runId] complete: X approved, Y failed. Failed: [task-a (reason), …]."` to the channel's `ConversationManager`. Next chat turn sees it in `initialMessages` and can answer "what failed?" factually.

### Fixed
- Phase 29 (Cost-Aware Fallback) marker — was deferred in v1.7, actually shipped in Phase 45 (v3.1). ROADMAP now reflects "Superseded by Phase 45".

## [v3.1] — 2026-04-14 — Context Intelligence

7 phases (45-51), 28 requirements. SQLite project index + index-aware tools + shared context files + cost-aware provider fallback.

### Added
- **FALL-01..04** `FallbackProvider` wraps primary + fallback with exponential backoff + full jitter, respects `Retry-After` header, emits `provider_switch` audit entry, TUI status bar fallback indicator. Closes Phase 29 debt from v1.7.
- **CTX-01..04** Context loader (`src/context/loader.ts`) — reads `CLAUDE.md` hierarchy (global `~/.claude/` → project root → cwd) plus `KC_MEMORY.md` / `MEMORY.md`. Prepended to system prompt in both CLI and Discord. `/context` slash command. Token-budget warning.
- **IDX-01..05, WATCH-01..03** `tm index` + `tm index watch` — SQLite-backed project index (`.kc-index/project.db`, WAL mode) with regex TS/JS symbol extractor. Incremental watcher with `fs.watch` + 100ms debounce + startup diff-scan + HEAD SHA polling for branch-change invalidation. `PRAGMA user_version` for schema migrations.
- **TOOL-01..03** Index-aware `glob` and `grep` tools — pre-filter candidate files via the index before hitting ripgrep. Opt-in via optional `IndexClient` parameter; identical fallback behavior when absent.
- **MCP-01..05** `tm index serve` — separate OS process exposing the index over MCP stdio transport with 4 tools (`search_files`, `find_symbol`, `list_symbols`, `index_status`). Strict stderr-only diagnostics.
- **DOG-01..02** Dogfood validation — all v3.1 services coexist on a single Mac without SQLite lock contention; Phase 24 launchd installer verified unbroken by v3.1 changes.
- **WIRE-01..02** Production wiring — all 5 entry points (CLI, agent-runner, Discord, orchestration CLI/Discord) now construct an `IndexClient` via `maybeLoadIndexClient()` and pass it to `buildAllTools`. Index infrastructure is live, not just unit-tested.

## [v3.0] — 2026-04-13 — Autonomous Orchestration

4 phases (41-44). Decomposer + parallel fan-out engine + templates + `--cheap` mode.

### Added
- **Phase 41** Dependency-aware task queue with `dependsOn` edges, `maxParallel` config cap, serialized git worktree operations, JSONL event-log replay for crash recovery.
- **Phase 42** Parallel fan-out — replaced the serial worker loop with DAG-aware `Promise.allSettled` batching. `MergeSerializer` serializes branch merges to avoid git index contention. Topological execution.
- **Phase 43** Project templates — `TemplateDefinition` schema + 3-5 built-in templates (Next.js site, REST API, CLI tool). `!orchestrate-template <name>` Discord command. Runtime environment check.
- **Phase 44** Decomposer — Opus NL→task-list with rationale per dependency edge, plan preview approval gate (Discord DM + CLI readline), `--cheap` flag routing all workers to GLM-4.7-Flash.

## [v2.0] — 2026-04-13 — Multi-Agent Orchestration

3 phases (38-40). Task state machine + worker/reviewer loop + CLI/Discord entry points.

### Added
- **Phase 38** Orchestration engine core — 9-state task machine, Zod-validated run config, JSONL event log, in-memory queue with disk persistence, per-task escalation policy, `maxWorkerTurns` + `maxOpusDollars` budget caps.
- **Phase 39** Worker/reviewer loop — GLM worker via `runSubagent` with git worktree isolation, structured diff handoff, Opus reviewer with `submit_review` tool, APPROVE/REJECT/REDIRECT decision loop, retry-history injection, max-retry → `escalated` terminal.
- **Phase 40** Entry points — `kc orchestrate` CLI subcommand + `!orchestrate` Discord command, Discord DM escalation (diff + reasoning) with p-queue pause/resume for human blocks.

## [v1.9] — 2026-04-13 — Ops & Observability

3 phases (35-37). Token tracking + graceful drain + auto-update webhook.

### Added
- **TOKEN-01..05** Per-turn Discord token/cost JSONL store, `tm discord usage` CLI, `!usage` Discord command, optional daily summary DM to owner.
- **UPDATE-06..07** Bot startup DM with version/commit/health, SIGTERM graceful drain (up to 30s for in-flight turns). Makes `launchctl kickstart -k` safe during active sessions.
- **UPDATE-01..05** `com.telemachus.webhook` launchd service — GitHub push webhook with HMAC-SHA256 + `timingSafeEqual`, async build pipeline (git pull → bun install → bun build → `launchctl kickstart -k`), 127.0.0.1 binding. ⚠ Requires a public tunnel to actually receive GitHub deliveries — see side-task.

## [v1.8] — 2026-04-12 — Discord Agent

5 phases (30-34). discord.js v14 gateway → agent loop → streaming + session persistence → job control → operational hardening.

### Added
- **CFG-01, SEC-10..12** discord.js v14 gateway with owner allowlist, bot token from env, GLM-4.7-Flash default model.
- **DISC-01..04, SEC-13** Per-channel `ConversationManager`, message chunking for 2000-char limit, typing indicator, source attribution in audit entries.
- **DISC-05..06** Streaming message edits throttled to Discord rate limits, sessions hydrated from JSONL on bot startup (survives restarts).
- **JOB-01..03** `!run <job>` and `!status` commands trigger launchd agent jobs from Discord; job completion posts results to configured channel.
- **OPS-01..04** `tm discord install/uninstall` launchd plists, message cache memory limits, LLM endpoint health check on startup.

## [v1.7] — 2026-04-10 — Model Routing

1 phase (Phase 28), 3 plans, 9 commits. Profile-driven provider/model selection.

### Added
- **ROUTE-01** `resolveEffectiveProvider(config, activeProfileName)` — pure function resolving profile `provider`/`model` overrides with graceful fallback. 6 TDD tests.
- **ROUTE-02** `/profile <name>` mid-session reconstructs the `Provider` instance when the profile has provider/model overrides. History preserved across backend switches. `/profile default` returns to top-level.
- **ROUTE-03** `/model` shows `[profile: local]` attribution when a profile overrides the provider.
- **ROUTE-04** Agent-runner per-job `provider`/`model` now flows into `createProvider` via conditional spread (was silently ignored before v1.7).

## [v1.6] — 2026-04-09 — Defense in Depth

3 phases (25-27), 10 plans, 43 commits. MCP sandbox + audit lifecycle events + cross-platform design docs.

### Added
- **SEC-06** MCP child subprocesses on macOS wrapped by Phase 17 `sandbox-exec` dispatcher — new `buildMcpInvocation` pure function, 14 decision-matrix tests.
- **SEC-07** Trust-tier network mapping: `dangerous`/`risky` always network-off, `safe` opts in via `sandbox.network: true`. Per-server `sandbox.paths` config.
- **SEC-08** Real-subprocess regression test — fixture MCP server proves EACCES on out-of-cwd writes and loopback TCP denial.
- **SEC-09** One-shot sandbox-unavailable warning on non-darwin + `mcp_sandbox_warning` audit entry.
- **MCP-06** `/mcp kill` emits `mcp_kill` audit entry before SIGTERM.
- **MCP-07** `/mcp disable` emits `mcp_disable` with `previous_tier` and `was_alive`.
- **MCP-08** `mcp_spawn` and `mcp_idle_kill` structured events — full MCP lifecycle reconstructable from audit log alone.
- **DOC-01** Linux sandbox design doc (bwrap recommended).
- **DOC-02** Windows sandbox design doc (AppContainer + Job Object via helper binary).

### Changed
- `AuditEntry` extended with flat `kind` discriminator for 6 event types. `parseAuditLine` backward-compat.
- v1.3-era `audit(name, event)` hack replaced with typed emit helpers on `McpManager`.

### Added
- **First-class `llamacpp` provider** — set `provider: "llamacpp"` and point at any llama.cpp `/v1` endpoint. Defaults to `http://localhost:8080/v1`. `KC_LLAMACPP_BASE_URL` env override for fast local↔remote switching.
- **Live llama.cpp model discovery** in `/model` picker — fetches `/v1/models` from the configured llamacpp endpoint with optional bearer auth, mirrors the existing Ollama live discovery flow.
- **`scripts/bench-local.ts`** — five-scenario benchmark harness (cold throughput, single tool call, tool disambiguation, multi-turn coherence, long-context recall) for any OpenAI-compatible endpoint. Reports TTFT, gen tok/s, pass/fail per scenario, JSON output for diffing runs.
- **`docs/guides/llama-cpp.md`** — full setup guide: Blackwell `sm_120` build flags, three launch recipes (GLM-4.7-Flash, Qwen3-Coder-Next, GPT-OSS 20B), Tailscale remote-access pattern, scheduled-task persistence, thinking-model knobs, SSH-install gotchas appendix.
- LLM-01: Local LLMs section in README covering Ollama install + config for macOS and Windows
- LLM-02: Default `~/.telemachus/config.json` now ships with a ready-to-use Ollama provider entry
- LLM-03: `/model` picker queries Ollama `/api/tags` and lists live local models
- LLM-04: Startup warning when using a non-tool-capable Ollama model
- Hoplite warrior ASCII banner rendered from `hoplite.png` via `chafa --symbols=block+vhalf`, colored with a bronze gradient matching the `TELEMACHUS` block letters. Subtitle `ΜΟΛΩΝ ΛΑΒΕ · personal coding agent · v1.0`.
- README, CHANGELOG documentation.
- Native Windows support for the bash tool (no WSL required) — runs commands via `cmd /c` by default (WIN-01)
- `KC_SHELL` environment variable to override the shell (e.g. `KC_SHELL=powershell` on Windows, `KC_SHELL=zsh` on macOS) (WIN-02)
- Clear error message with WSL fallback suggestion when no supported shell is found on Windows (WIN-03)
- Cross-platform path handling tests for session store, grep, and glob tools (WIN-04)
- Windows Setup section in README

### Changed
- MCP connect timeout bumped from 5 s → 30 s so heavy servers (large-database MCPs) have cold-start time.
- bash tool process group kill (`process.kill(-pid)`) is now Unix-only; Windows uses direct `proc.kill()`

### Fixed
- **Model picker no longer mis-routes ollama selections to `api.openai.com`.** `handleModelSelect` previously collapsed every non-anthropic key to `provider: 'openai-compat'` without copying the chosen entry's `baseURL`/`apiKey` into the registry's dispatch slot. The OpenAI SDK silently defaulted to `https://api.openai.com/v1` and the apiKey fell back to the literal string `"ollama"`, producing `401 Incorrect API key provided: ollama`. Resolution logic extracted to `applyModelSelection()` with regression test that explicitly asserts the resolved provider hits `localhost:11434`, not `api.openai.com`. The picker now also surfaces switch errors in the chat instead of leaving the session in a broken state, and the `(current)` label matches by `providerKey + model` so multiple backends serving the same model name don't all flag themselves as current.

## [v1.4] — 2026-04-08 — Lean Local

Three phases ship together: MCP profiles (Phase 19), first-class CLI tool (Phase 20), and a complete TUI revamp (Phase 21). 7/7 requirements, 526/526 tests (+176 over v1.3.1 baseline), clean build, audit PASSED.

### Phase 19: MCP Profiles + Schema Budget

- **LEAN-01** Named profiles in `~/.telemachus/config.json` under `profiles.<name>` with per-profile `mcpServers` allowlists that **exclude servers from the LLM tool manifest entirely** — not just from eager spawn. Profile switching via `--profile <name>` CLI flag, `/profile <name>` slash command, or top-level `activeProfile` key. Session switches never write to config. Absence of `profiles` is backwards-compatible with v1.3.
- **LEAN-03** `/cost --verbose` (or `/cost -v`) shows per-tool schema token cost sorted descending alongside the existing per-server totals. Configurable `mcpDefaults.schemaBudgetTok` (default 200) triggers a one-time stderr warning at startup listing any tools that exceed the threshold.

### Phase 20: First-class CLI Tool

- **LEAN-02** Declare CLI binaries as built-in tools in `cliTools.<name>` with `command`, `description`, default `trustTier`, and optional `subCommandTiers` map for sub-command-level overrides (e.g. `"pr list": "safe"`, `"pr merge": "dangerous"`). Each entry surfaces as a first-class tool with a ~30-token schema (name + description + `args: string`).
- Shell-style arg parser splits quoted strings into argv without invoking a shell. Metachar validator rejects backticks, `$(…)`, `$((…))`, `;`, `|`, `&`, `>`, `<`, `&&`, `||`, and unbalanced quotes before execution.
- Longest-prefix sub-command tier resolution: `gh pr merge 123` → tries `"pr merge 123"`, `"pr merge"`, `"pr"`, falls through to default tier on no match. No silent escalation.
- Dispatch pipeline: parse → validate → resolve tier → sandbox via Phase 17 wrapper → spawn → audit as `cli:<name>` with arg hash (never raw args).
- Wired into the production tool registry via `registerAll(buildAllTools(config))` at startup — regression-guarded by a grep-based smoke test against `src/index.ts`.

### Phase 21: TUI Revamp

- **UI-01** Multi-line input. `Shift+Enter` inserts a newline, `Enter` submits. Arrow keys move the cursor character-by-character and line-by-line within the draft. Input area grows up to `ui.inputMaxLines` (default 10), then scrolls internally. Built as a pure reducer (`src/ui/input-state.ts`) wrapped in an Ink component (`src/ui/input.tsx`) with `ink-testing-library` component tests.
- **UI-04** `Up`/`Down` at empty or unedited input walks through prior user turns in shell-history style. In multi-line drafts, Up/Down at the top/bottom edge enters history mode; otherwise moves the cursor. History resets on `/clear` and on session restart.
- **UI-02** Image paste. On vision-capable models (Claude Sonnet/Opus 4.x, GPT-4o family, Gemini, multimodal llama.cpp GGUF via `modelSupportsVision`), pasted or dragged images attach to the next turn as multipart content blocks and persist in the session JSONL. On non-vision models, a yellow warning appears and the attachment is dropped silently on submit. All images dropped on `/clear`.
- **UI-03** Collapsible tool-use blocks. Outputs longer than `ui.toolOutputCollapseThreshold` (default 10 lines) collapse by default showing `▸ Tool: <name> (N lines, X ms)`. Tab/Shift+Tab cycles focus between blocks, Enter toggles expand/collapse, Escape clears focus. Works uniformly for built-in, MCP, and CLI tools.

### Milestone-audit save

The integration checker caught a critical LEAN-02 wiring gap that verify-phase missed — `src/index.ts` was registering only `allBuiltinTools`, never calling `buildAllTools(config)`. All 47+ Phase 20 unit tests passed because they constructed local registries, but a real user with `cliTools` in config would have seen zero CLI tools. Fixed with a one-line change + grep-based regression test. v1.4 would have shipped broken without the audit.

### Known Tech Debt (carried to v1.5)

- **MCP child subprocesses still bypass the Phase 17 sandbox** — carried from v1.3, now flagged in two milestone audits. v1.5 defense-in-depth candidate.
- **Profile-level `cliTools` filtering unwired** — `ProfileConfig.cliTools` is typed but not read. Profiles currently restrict MCP servers but not CLI tools.
- **CLI tool naming inconsistency** — Phase 20 registers as bare `gh`; Phase 21 `ToolBlock` was designed to render as `cli:gh`. Display is functional but inconsistent.
- **`/mcp kill` / `/mcp disable` still don't emit audit events** — carried from v1.3.
- **Pre-existing tsc errors** in providers/anthropic, bash.ts, registry.ts, bun-types — tracked internally.

## [v1.3.1] — 2026-04-08 — MCP config: env var expansion + cwd support

Point release on top of v1.3 closing two gaps surfaced while migrating a real `~/.claude.json` into `~/.telemachus/config.json`.

### Added
- **Env var expansion in MCP config** (`src/config/env-expand.ts`). `${VAR}` and `$VAR` placeholders inside `mcpServers[*].command`, `args`, `env`, and `cwd` are expanded from `process.env` at config load. Missing vars expand to empty string and emit a one-time stderr warning — never fail config load. Lets secrets stay in the shell env (`~/.zshrc`, keychain-sourced, or a gitignored `.env`) instead of plaintext JSON.
- **`cwd` field on `McpServerConfig`**. Servers that rely on relative module imports (e.g. `python -m foo` with a project-local venv) can now set a working directory. Passed through to `StdioClientTransport`.

### Fixed
- MCP config on v1.3.0 silently dropped the `cwd` field — Python servers using `python -m` with a project-local venv would fail at import time when migrated from `~/.claude.json`. Now carried through end-to-end.

## [v1.3] — 2026-04-08 — Security & Efficiency

Two phases ship together: bash hardening (Phase 17) and MCP surface control (Phase 18). 12/12 requirements, 294/294 tests, clean build.

### Phase 17: Bash Hardening + Security Foundations

- **SEC-01** Trust tiers (`safe` / `risky` / `dangerous`) replace the binary `SAFE_TOOLS` set. `web_search` and `web_fetch` are now `risky` and prompt in ask mode. Unknown tools default to `dangerous` (fail-closed).
- **SEC-02** Append-only JSONL audit log at `~/.telemachus/audit/<YYYY-MM-DD>.jsonl`. Stores arg hashes (SHA-256), never raw args. Daily rotation, kept forever, prune manually.
- **SEC-03** macOS `sandbox-exec` wrapper around the `bash` tool. Default-deny profile: network off, writes scoped to cwd + `/private/tmp/kc-<sessionId>`, reads allowed.
- **SEC-04** Opt-in `network: true` flag on bash surfaces `[network] ` prefix in the permission prompt. yolo mode bypasses the sandbox with visible `[sandbox: BYPASSED]` prefix and audit entry.
- **SEC-05** Linux/Windows: one-time session warning that bash runs unsandboxed; audit log records `sandbox: "n/a"`.
- **SEC-06** README Security section: honest description of what the sandbox enforces, what it doesn't, and when yolo bypasses.
- Failure mode: if `sandbox-exec` is unavailable on macOS, bash is disabled outside yolo (fail-closed). In yolo, results are prefixed `[sandbox: UNAVAILABLE]`.

### Phase 18: MCP Surface Control

- **MCP-01** MCP servers are now **opt-in and lazy by default**. Fresh config with no `mcpServers` block → startup banner prints `0 MCP servers loaded (see config)` and zero subprocesses exist. The legacy `~/.claude.json` auto-mount is gone.
- **MCP-02** Config schema moved to `~/.telemachus/config.json` under `mcpServers`. Per-server `eagerLoad: true` restores pre-v1.3 behavior (load at startup). Top-level `mcpDefaults: { idleTimeoutMs, trustTier }` provides global defaults.
- **MCP-03** Lazy servers spawn on first tool call and are killed after `idleTimeoutMs` (default 10 min). Next call transparently respawns. `SIGTERM` → 2 s grace → `SIGKILL`. All lifecycle events land in the audit log.
- **MCP-04** New `/mcp` slash command. Table view: `name | mode (eager/lazy) | status (alive/idle/dead) | last activity | tools | trust`. Subcommands: `/mcp enable|disable|spawn|kill <name>` — session-scoped, never edits your config file.
- **MCP-05** `/cost` output now attributes per-turn tool-schema token cost. Three-line breakdown: `builtin: N tok`, `mcp: M tok total`, plus indented per-server lines. Tokenized via `gpt-tokenizer`. Schema bloat is finally observable.
- **MCP-06** MCP tools default to the `dangerous` trust tier via a dedicated override registry (not the `getTier()` fallthrough). Promotion requires explicit `trustTier: 'safe' | 'risky' | 'dangerous'` per server, or per-tool via `toolOverrides: { toolName: tier }`.

### Known Tech Debt (carried to v1.4)

- MCP child subprocesses spawn via raw `StdioClientTransport` and are **not** wrapped by the Phase 17 sandbox. No requirement mandated this; documented under "What's NOT protected" in the security guide.
- `/mcp kill` and `/mcp disable` don't yet emit audit events (only idle-kill does).
- Legacy `loadMcpClients()` in `src/config/mcp-config.ts` is unreachable dead code.

## [v1.0] — 2026-04-06

Initial MVP release. 7 phases, 16 plans, 13/13 requirements validated.

### Phase 1: Foundation
- Provider abstraction (Anthropic native, OpenAI-compat, Ollama)
- 10 built-in tools (bash, file r/w/edit, grep, glob, web_search, ask, todo)
- Agent loop with sequential tool dispatch, streaming, error wrapping
- Config loader (`~/.telemachus/config.json` + env overrides)
- Launchable `kc` binary via `bun link`

### Phase 2: Context & Telemetry
- Orphan-safe sliding window that never severs `tool_use` / `tool_result` pairs
- Live status bar: tokens in/out, session total, USD cost, context window %

### Phase 3: MCP & Skills
- MCP client (degraded-mode) reading `~/.claude.json`
- Tool namespace bridge (MCP tools appear alongside built-ins)
- Skill loader exposing `~/.claude/skills/*` as slash commands
- Tab completion for slash commands

### Phase 4: Session Persistence
- JSONL auto-save to `~/.telemachus/sessions/{uuid}.jsonl`
- Atomic write pattern (tmp → datasync → rename) satisfying HV-03
- `kc -r` interactive picker, `kc --session <uuid>` direct resume
- Invalid-session error path with exit code 1

### Phase 5: Permission System
- Three modes: `yolo` / `ask` / `readonly`
- Resolution priority: config → env (`KC_MODE`) → `--mode` CLI flag
- Inline Ink permission prompt with `y / n / a` keys
- Allow-always session memory (no re-prompt for same tool after `a`)
- Status bar mode color coding

### Phase 6: Polish
- `/compact` — on-demand LLM summarisation (summary + last 3 turns)
- `/model` — inline picker to switch provider mid-session
- `/clear` — wipe conversation and reset counters
- `bun build --compile` produces standalone `kc` binary

### Phase 7: Foundation Cleanup (Gap Closure)
- `isServerTool` flag now propagates through `toAPISchema()` and `toAPISchemaForProvider()` — Anthropic beta routing path (e.g. `web_search`) is reachable
- MCP startup stderr deduplicated per failing server (single warning line instead of repeated spam)
- `REQUIREMENTS.md` traceability synced — all 13 requirements marked complete
