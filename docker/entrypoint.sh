#!/bin/sh
# Telemachus Docker entrypoint
#
# Validates required environment variables for the selected service, writes a
# minimal ~/.telemachus/config.json (DEFAULT_CONFIG has no discord/telegram
# section, so the bot exits 1 immediately without it), then execs the tm binary.
#
# All secrets flow from environment variables — no macOS Keychain involved.
set -e

SERVICE="${TM_SERVICE:-discord}"
CONFIG_DIR="${HOME}/.telemachus"
CONFIG_FILE="${CONFIG_DIR}/config.json"

mkdir -p "$CONFIG_DIR"

case "$SERVICE" in
  discord)
    if [ -z "$DISCORD_BOT_TOKEN" ]; then
      echo "ERROR: DISCORD_BOT_TOKEN is required when TM_SERVICE=discord" >&2
      echo "  Get your bot token at: Discord Developer Portal -> Your App -> Bot -> Token" >&2
      exit 1
    fi
    if [ -z "$DISCORD_OWNER_ID" ]; then
      echo "ERROR: DISCORD_OWNER_ID is required when TM_SERVICE=discord" >&2
      echo "  Get your Discord user ID: enable Developer Mode in Discord, right-click your username -> Copy User ID" >&2
      exit 1
    fi
    cat > "$CONFIG_FILE" <<JSON
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "discord": {
    "tokenEnv": "DISCORD_BOT_TOKEN",
    "allowedUsers": []
  }
}
JSON
    exec tm discord
    ;;
  telegram)
    if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
      echo "ERROR: TELEGRAM_BOT_TOKEN is required when TM_SERVICE=telegram" >&2
      echo "  Get your bot token from @BotFather on Telegram (/newbot)" >&2
      exit 1
    fi
    if [ -z "$TELEGRAM_OWNER_CHAT_ID" ]; then
      echo "ERROR: TELEGRAM_OWNER_CHAT_ID is required when TM_SERVICE=telegram" >&2
      echo "  Get your chat ID: message @userinfobot on Telegram" >&2
      exit 1
    fi
    cat > "$CONFIG_FILE" <<JSON
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "telegram": {
    "tokenEnv": "TELEGRAM_BOT_TOKEN",
    "ownerChatId": ""
  }
}
JSON
    exec tm telegram
    ;;
  *)
    echo "ERROR: TM_SERVICE must be 'discord' or 'telegram' (got: ${SERVICE})" >&2
    echo "  Set TM_SERVICE=discord or TM_SERVICE=telegram in your .env file" >&2
    exit 1
    ;;
esac
