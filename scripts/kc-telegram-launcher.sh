#!/bin/bash
# TGDEPLOY-03 (Phase 72): launchd wrapper — retrieves Telegram bot token and
# owner chat ID from macOS Keychain and exports them as TELEGRAM_BOT_TOKEN
# and TELEGRAM_OWNER_CHAT_ID before exec'ing `tm telegram`.
#
# Three cases per secret:
#   1. Keychain entry present (happy path)              → use Keychain value
#   2. Keychain absent but KC_TELEGRAM_* env var set    → warn to stderr, use env var
#   3. Neither available                                → loud error, exit 1
#
# Install target: ~/.telemachus/scripts/kc-telegram-launcher.sh
# Referenced by: ~/Library/LaunchAgents/com.telemachus.telegram.plist
#                (ProgramArguments → [this script])
set -e

TOKEN=""
OWNER_ID=""

if command -v security >/dev/null 2>&1; then
  TOKEN=$(security find-generic-password -s kc-telegram-token -w 2>/dev/null || true)
  OWNER_ID=$(security find-generic-password -s kc-telegram-owner-id -w 2>/dev/null || true)
fi

# Token env-var fallback
if [ -z "$TOKEN" ] && [ -n "$KC_TELEGRAM_TOKEN" ]; then
  echo "[kc-telegram-launcher] WARNING: keychain entry 'kc-telegram-token' not found; falling back to KC_TELEGRAM_TOKEN env var. Run scripts/setup-keychain.sh to migrate." >&2
  TOKEN="$KC_TELEGRAM_TOKEN"
fi
if [ -z "$TOKEN" ]; then
  echo "[kc-telegram-launcher] ERROR: no token available (neither 'kc-telegram-token' Keychain entry nor KC_TELEGRAM_TOKEN env). Run scripts/setup-keychain.sh first." >&2
  exit 1
fi

# Owner-id env-var fallback
if [ -z "$OWNER_ID" ] && [ -n "$KC_TELEGRAM_OWNER_ID" ]; then
  echo "[kc-telegram-launcher] WARNING: keychain entry 'kc-telegram-owner-id' not found; falling back to KC_TELEGRAM_OWNER_ID env var. Run scripts/setup-keychain.sh to migrate." >&2
  OWNER_ID="$KC_TELEGRAM_OWNER_ID"
fi
if [ -z "$OWNER_ID" ]; then
  echo "[kc-telegram-launcher] ERROR: no owner chat ID available (neither 'kc-telegram-owner-id' Keychain entry nor KC_TELEGRAM_OWNER_ID env). Run scripts/setup-keychain.sh first." >&2
  exit 1
fi

export TELEGRAM_BOT_TOKEN="$TOKEN"
export TELEGRAM_OWNER_CHAT_ID="$OWNER_ID"
exec tm telegram
