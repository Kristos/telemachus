#!/bin/bash
# HYG-04 (Phase 65): one-time setup — prompts for Discord bot token, stores
# in macOS Keychain so launchd plist no longer needs to embed it inline.
#
# Usage:
#   bash scripts/setup-keychain.sh
#
# Idempotent: safe to re-run to rotate the token. The `-U` flag to
# `security add-generic-password` updates the existing entry in place.
set -e

if ! command -v security >/dev/null 2>&1; then
  echo "ERROR: macOS 'security' binary not found." >&2
  echo "Keychain setup is macOS-only. On Linux, set KC_DISCORD_TOKEN env var instead." >&2
  exit 1
fi

# Read token without echoing to terminal
read -r -s -p "Discord bot token: " TOKEN
echo
if [ -z "$TOKEN" ]; then
  echo "ERROR: empty token" >&2
  exit 1
fi

# -U flag: update existing entry idempotently
# -a: account (user name, cosmetic)
# -s: service name (the key we look up later)
# -w: password (the secret)
security add-generic-password \
  -a "$USER" \
  -s kc-discord-token \
  -w "$TOKEN" \
  -U

# Verify without -w so the token is NOT echoed back to the terminal
if security find-generic-password -s kc-discord-token >/dev/null 2>&1; then
  echo "OK: token stored in Keychain (service: kc-discord-token)"
  echo
  echo "Next steps:"
  echo "  1. Re-install the Discord launchd job:  tm discord install"
  echo "  2. Restart the bot:                      launchctl kickstart -k gui/\$(id -u)/com.telemachus.discord"
  echo "  3. Tail the log:                         tail -f ~/.telemachus/logs/discord-stderr.log"
else
  echo "ERROR: verification failed — security find-generic-password could not locate the entry we just wrote." >&2
  exit 1
fi

# ─── Telegram (Phase 72, TGDEPLOY-03) ────────────────────────────────────────
echo
read -r -s -p "Telegram bot token (leave blank to skip Telegram setup): " TG_TOKEN
echo
if [ -n "$TG_TOKEN" ]; then
  read -r -p "Telegram owner chat ID (numeric): " TG_OWNER_ID
  if [ -z "$TG_OWNER_ID" ]; then
    echo "ERROR: empty owner chat ID" >&2
    exit 1
  fi

  security add-generic-password \
    -a "$USER" \
    -s kc-telegram-token \
    -w "$TG_TOKEN" \
    -U

  security add-generic-password \
    -a "$USER" \
    -s kc-telegram-owner-id \
    -w "$TG_OWNER_ID" \
    -U

  if security find-generic-password -s kc-telegram-token >/dev/null 2>&1 \
     && security find-generic-password -s kc-telegram-owner-id >/dev/null 2>&1; then
    echo "OK: Telegram secrets stored in Keychain (services: kc-telegram-token, kc-telegram-owner-id)"
    echo
    echo "Next steps:"
    echo "  1. Install the Telegram launchd job:    tm telegram install"
    echo "  2. Tail the log:                         tail -f ~/.telemachus/logs/telegram-stderr.log"
  else
    echo "ERROR: verification failed for Telegram Keychain entries." >&2
    exit 1
  fi
fi
