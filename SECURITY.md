# Security Policy

## Supported Versions

Telemachus is a single-owner self-hosted assistant maintained as a hobby project. Security fixes ship on the latest tagged release only — there is no LTS branch. If you are running off `main`, pull and rebuild to get fixes.

| Version | Supported |
|---------|-----------|
| Latest tagged release on `main` | ✅ |
| Older tags | ❌ — please upgrade |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/Kristos/telemachus/security/advisories/new>
2. Describe the issue, including:
   - The component (Discord, Telegram, agent loop, sandbox, MCP, webhook server)
   - A reproduction (steps, payload, or PoC)
   - The impact you observed (RCE, secret exfiltration, sandbox escape, etc.)
   - The Telemachus version (tag or commit SHA) and how you deployed it (Docker, native, launchd)

You should get an acknowledgement within **7 days**. For confirmed issues we aim to ship a fix within **30 days** of triage; severe issues (RCE, secret exfiltration, sandbox escape) get prioritised.

If GitHub's private reporting is unavailable to you, email the maintainer at the address listed on their GitHub profile.

## Threat model — what's in scope

Telemachus is built around the assumption that **only the configured owner can talk to the bot** and that **the LLM is partially trusted** (it executes tools the owner has authorised).

In scope:

- **Owner allowlist bypass** — anything that lets a non-owner trigger tool execution via Discord, Telegram, or the webhook receiver
- **Sandbox escape** — bash commands or file writes that escape the macOS sandbox-exec / Linux fs constraints documented in the security guide
- **Secret leakage** — env vars, API keys, or session content surfacing in logs, audit lines, error messages, or DM replies
- **Webhook auth bypass** — accepting a GitHub auto-update push without valid HMAC, or accepting any other unauthenticated trigger
- **Path traversal in tools** — file_read/write/edit accepting paths outside the project root or the configured cwd
- **Permission gate bypass** — `ask` mode tools running without prompting the owner, or `plan` mode tools touching the filesystem

## Out of scope

- **Misconfiguration by the operator** — running with `permissionMode: "yolo"` and an untrusted LLM, exposing webhook ports without the auto-update HMAC secret, committing `.env` to a public repo
- **DoS via expensive prompts** — token budget enforcement is best-effort
- **LLM jailbreaks per se** — if a prompt convinces the LLM to call tools the owner authorised, that's intended behaviour; the issue is in the permission layer if the *owner didn't authorise it*
- **Vulnerabilities in dependencies** without a Telemachus-specific exploitation path — please report those upstream (Dependabot will pick most up automatically)

## Disclosure

We prefer coordinated disclosure: report privately, get a fix, then publish details after the fix ships. We'll credit you in the release notes unless you ask us not to.
