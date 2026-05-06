# vhs script for the README demo GIF.
#
# Run:  vhs docs/assets/demo.tape  →  produces docs/assets/demo.gif
# Install vhs: https://github.com/charmbracelet/vhs
#
# Records a fresh-clone Discord setup followed by a live DM exchange.
# The Discord side is faked with a small expect-style script (mock-discord.sh)
# so the recording doesn't depend on a real bot token.

Output docs/assets/demo.gif

Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Type "git clone https://github.com/Kristos/telemachus.git && cd telemachus"
Enter
Sleep 800ms

Type "cp .env.example .env"
Enter
Sleep 400ms

Type "# fill in ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, DISCORD_OWNER_ID"
Enter
Sleep 600ms

Type "docker compose up discord"
Enter
Sleep 4s

# Simulate Discord DM exchange in a split pane (recorded separately;
# composite the bot reply screenshot into the GIF post-record if needed).
Type "# DM the bot:  'List the files in /tmp'"
Enter
Sleep 2s

Type "# Bot replies with a real ls output"
Enter
Sleep 2s
