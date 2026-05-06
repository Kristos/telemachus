# Keychain-backed Discord bot token

Phase 65 (HYG-04) migrates the Discord bot token off inline plist storage and into the macOS Keychain, read lazily at every launchd start via a wrapper script.

## Why

Before this migration `~/Library/LaunchAgents/com.telemachus.discord.plist` embedded the token in plain XML:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/Users/you/.bun/bin:/opt/homebrew/bin:...</string>
    <key>KC_DISCORD_TOKEN</key>
    <string>MTEw...actual token here...</string>  <!-- leak site -->
</dict>
```

The default mode for this file is `0644` (world-readable). Any process running under the user's UID — or any backup/sync tool with access to the LaunchAgents directory — could read the token. Keychain provides per-app ACL, SecKeychain protection class, and FileVault integration at rest.

After migration the plist contains zero secret material:

```xml
<key>ProgramArguments</key>
<array>
    <string>/Users/you/.telemachus/scripts/kc-discord-launcher.sh</string>
</array>
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/Users/you/.bun/bin:/opt/homebrew/bin:...</string>
</dict>
```

The wrapper script retrieves the token via `security find-generic-password` at launch time.

## Prerequisites

- **macOS only.** Keychain is a macOS-specific service. Linux has `libsecret` / Secret Service but integration is deferred to v3.7 PORT-01.
- On **Linux** (CI, headless deploys), set `KC_DISCORD_TOKEN` as an env var in your launchd/systemd equivalent. The wrapper falls back to this env var with a stderr warning when Keychain is unavailable.

## One-time setup

From the repo root:

```bash
bash scripts/setup-keychain.sh
```

You will be prompted for the Discord bot token. Paste and press Enter. The script:

1. Stores the token via `security add-generic-password -a "$USER" -s kc-discord-token -w <token> -U`. The `-U` flag means "update in place if already present" — the script is idempotent; re-running it is how you rotate the token.
2. Verifies with `security find-generic-password -s kc-discord-token` (no `-w`, so the token is NOT echoed to the terminal).
3. Prints the follow-up steps: `tm discord install`, `launchctl kickstart -k ...`, tail the log.

After step 3, the bot restarts and the launcher wrapper (`scripts/kc-discord-launcher.sh`) reads the token from Keychain and execs `tm discord` with `DISCORD_BOT_TOKEN` exported.

## How it works

```
launchd (com.telemachus.discord)
    │
    ▼
~/.telemachus/scripts/kc-discord-launcher.sh
    │
    ├── command -v security? ─ yes ─► security find-generic-password -s kc-discord-token -w
    │                                         │
    │                                         └── success? ─ yes ─► TOKEN=<value>
    │                                                         no  ─► fall through
    │
    ├── TOKEN still empty? ─ yes ─► is KC_DISCORD_TOKEN set?
    │                                 │
    │                                 ├── yes ─► warn to stderr, TOKEN=$KC_DISCORD_TOKEN
    │                                 └── no  ─► ERROR, exit 1
    │
    ▼
export DISCORD_BOT_TOKEN="$TOKEN"
exec tm discord
```

Case matrix:

| Keychain entry | `KC_DISCORD_TOKEN` env | Behavior                                                |
| -------------- | ---------------------- | ------------------------------------------------------- |
| present        | any                    | Use Keychain. Silent happy path.                        |
| absent         | set                    | Warn to stderr, use env var. Bot starts normally.       |
| absent         | unset                  | Loud error to stderr, exit 1. Bot fails to start.       |

On first migration, users on Linux see the warning once per bot restart until they run setup-keychain.sh on macOS (or we ship PORT-01 Linux support).

## Token rotation

Generate a new Discord bot token, then:

```bash
bash scripts/setup-keychain.sh
# paste new token
launchctl kickstart -k gui/$(id -u)/com.telemachus.discord
```

The `-U` flag updates the existing Keychain entry; no delete-then-add dance required. The bot picks up the new token on the next launch.

## Troubleshooting

### "keychain entry 'kc-discord-token' not found" (warning)

Fresh install — run `bash scripts/setup-keychain.sh`.

### "security command not found" (from setup-keychain.sh)

You are not on macOS. See the fallback section above — use `KC_DISCORD_TOKEN` env var instead.

### "permission denied" when `security` tries to read the entry

Open Keychain Access.app. Search for `kc-discord-token`. Double-click. Go to Access Control tab. Either allow `kc` / `security` explicitly, or select "Allow all applications" (less secure but simpler for dev machines).

### Token leaked in logs

The launcher exports `DISCORD_BOT_TOKEN` and execs `tm discord`. `tm discord` must never log the token. If you see the token in `~/.telemachus/logs/discord-stderr.log`, that's a bug in kc — report it.

## Cross-OS posture

- **macOS**: Keychain (this doc).
- **Linux**: env var `KC_DISCORD_TOKEN` + wrapper fallback. Native Secret Service integration deferred to v3.7 PORT-01.
- **CI**: Set `KC_DISCORD_TOKEN` via secret manager (GitHub Actions, 1Password CLI, etc.). The launcher script is bypassed in CI since we run `tm discord` directly, not under launchd.

## See also

- `scripts/setup-keychain.sh` — the setup script itself.
- `scripts/kc-discord-launcher.sh` — the wrapper invoked by launchd.
- `src/discord/launchd.ts` `renderDiscordPlist` — generates the new plist shape that references the wrapper.
- Phase 65 HYG-04 (internal plan)..
