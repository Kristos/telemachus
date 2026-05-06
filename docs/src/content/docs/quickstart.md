---
title: Quickstart
description: Get Telemachus running in under a minute.
---

Get Telemachus running in under a minute.

## 1. Install

```bash
git clone git@github.com:Kristos/telemachus.git
cd telemachus
bun install
bun link
```

You need [Bun](https://bun.sh) 1.3+ and [ripgrep](https://github.com/BurntSushi/ripgrep).

## 2. Set an API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use a local model — see [Local LLMs](/guides/local-llms/).

## 3. Run it

```bash
tm
```

First run creates `~/.telemachus/config.json` with sensible defaults.

## 4. Try a prompt

```
> list all typescript files in src/ and summarise the entry point
```

Telemachus will grep, read files, and reply with a summary — all inside a single turn, with a live token/cost status bar at the bottom of the screen.

## Discover more

Inside `tm`:

- Type **`/help`** for a built-in cheat sheet (slash commands, permission modes, how to add paid providers and local models)
- Type **`/model`** to switch providers/models mid-session
- Type **`/cost`** for a usage + USD breakdown

## Next steps

- [Installation](/installation/) — full install instructions including compiled binary
- [Providers & models](/guides/providers/) — switching between Anthropic, OpenAI, Ollama
- [Built-in tools](/reference/tools/) — what the agent can actually do
- [Windows setup](/guides/windows/) — native Windows instructions
