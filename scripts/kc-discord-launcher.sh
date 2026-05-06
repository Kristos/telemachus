#!/bin/bash
# HYG-04 (Phase 65): launchd wrapper — retrieves Discord bot token from macOS
# Keychain and exports it as DISCORD_BOT_TOKEN before exec'ing `tm discord`.
#
# Three cases:
#   1. Keychain entry present (happy path)   → export token, exec tm discord
#   2. Keychain absent but KC_DISCORD_TOKEN set → warn to stderr, use env var
#   3. Neither available                     → loud error, exit 1
#
# Install target: ~/.telemachus/scripts/kc-discord-launcher.sh
# Referenced by: ~/Library/LaunchAgents/com.telemachus.discord.plist
#                (ProgramArguments → [this script])
set -e

TOKEN=""

# Case 1: macOS Keychain (happy path)
if command -v security >/dev/null 2>&1; then
  TOKEN=$(security find-generic-password -s kc-discord-token -w 2>/dev/null || true)
fi

# Case 2: env var fallback with loud warning
if [ -z "$TOKEN" ] && [ -n "$KC_DISCORD_TOKEN" ]; then
  echo "[kc-discord-launcher] WARNING: keychain entry 'kc-discord-token' not found; falling back to KC_DISCORD_TOKEN env var. Run scripts/setup-keychain.sh to migrate." >&2
  TOKEN="$KC_DISCORD_TOKEN"
fi

# Case 3: nothing available — fail loudly
if [ -z "$TOKEN" ]; then
  echo "[kc-discord-launcher] ERROR: no token available (neither 'kc-discord-token' Keychain entry nor KC_DISCORD_TOKEN env). Run scripts/setup-keychain.sh first." >&2
  exit 1
fi

export DISCORD_BOT_TOKEN="$TOKEN"
exec tm discord
