# Contributing to Telemachus

Telemachus is a personal AI assistant that you self-host and own entirely. Contributions are welcome — particularly new providers, MCP server integrations, bug fixes, and documentation improvements.

---

## Dev Setup

**Prerequisites:** Bun 1.3+, ripgrep (`rg`), git.

```bash
git clone https://github.com/Kristos/telemachus.git
cd telemachus
bun install
cp .env.example .env          # fill in at minimum ANTHROPIC_API_KEY
bun run src/index.ts          # interactive TUI — press Ctrl+C to exit
```

**Run tests:**

```bash
bun test
```

**Compile binary:**

```bash
bun run build:compile         # produces ./tm at repo root
```

---

## Project Structure

```
telemachus/
├── src/
│   ├── index.ts              # CLI dispatcher — subcommand routing entry point
│   ├── agent/                # Agent loop, tool dispatch, /compact summarization
│   ├── agent-runner/         # Headless job runner, launchd service, status CLI
│   ├── config/               # Config loader, types, profile resolution
│   ├── context/              # CLAUDE.md/MEMORY.md loader (shared with Claude Code)
│   ├── discord/              # Discord bot transport (gateway, streaming, commands)
│   ├── telegram/             # Telegram bot transport (polling)
│   ├── mcp/                  # MCP stdio client manager (lazy spawn, idle cleanup)
│   ├── orchestration/        # Multi-agent orchestration engine, workers, templates
│   ├── permissions/          # Permission modes (yolo / ask / readonly)
│   ├── project-index/        # SQLite file and symbol index, watcher, MCP server
│   ├── providers/            # LLM provider implementations + router + fallback
│   ├── security/             # Trust tiers, audit log, sandbox wrapper
│   ├── session/              # JSONL session persistence, resume
│   ├── tools/                # Built-in tools (bash, file R/W, grep, web search, MCP bridge)
│   └── ui/                   # Ink/React components, status bar, slash commands
├── docs/                     # Astro-based documentation site
├── tests/                    # Test suite (run with `bun test`)
├── docker-compose.yml        # Docker services: discord, telegram
├── Dockerfile                # Multi-stage build — bun install → compile → runtime
├── .env.example              # Environment variable template
└── config.example.json       # Config file examples (minimal + full)
```

---

## How to Add a Provider

1. Create `src/providers/your-name.ts`.

2. Implement the `Provider` interface from `src/providers/types.ts`:

   ```typescript
   import type { Provider, Message, APIToolSchema, StreamOptions, StreamResponse } from './types.js'

   export class YourProvider implements Provider {
     readonly name = 'your-name'

     async stream(
       messages: Message[],
       tools: APIToolSchema[],
       opts: StreamOptions,
     ): Promise<StreamResponse> {
       // Call your API.
       // Stream text chunks via opts.onTextChunk(chunk).
       // Return { text, toolCalls, usage, stopReason }.
     }

     // Optional — implement if the provider has a token counting API:
     // async countTokens(messages: Message[]): Promise<number> { ... }
   }
   ```

3. Register the provider in `src/providers/registry.ts` — add a `case 'your-name':` branch in `createProvider()`.

4. Add `'your-name'` to the `provider` union type in `src/config/types.ts`.

5. Document any new required env vars in `.env.example`.

6. Add tests under `tests/providers/` that exercise `stream()` against a mocked HTTP endpoint.

---

## PR Guidelines

- Fork the repo, branch off `main`, open a PR against `main`.
- One feature or fix per PR — keep the scope focused.
- `bun test` must pass before requesting review.
- No hardcoded API keys, tokens, or personal identifiers.
- Update README.md and/or `docs/src/content/docs/` for any user-visible changes.
- Keep commits focused; squash into logical units if requested.

---

## Code Style

- **TypeScript strict mode** — `tsconfig.json` has `"strict": true`.
- **Immutability** — always create new objects; never mutate config or state in place. Use spread + return.
- **File size** — 200–400 lines is typical; 800 lines is the hard maximum. Extract utilities when files grow large.
- **Error handling** — catch exceptions, log with context to stderr, and continue. Never swallow errors silently.
- **No `console.log`** — use `process.stderr.write()` for debug output; it does not pollute stdout/TUI rendering.
- **No `mock.module()` in tests** — it causes cross-file contamination in Bun's test runner. Use `spyOn()` and restore in `afterEach`.
