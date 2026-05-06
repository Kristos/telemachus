---
title: Windows setup
description: Run Telemachus natively on Windows — no WSL required.
---

Telemachus runs natively on Windows as of v1.1. WSL is no longer required, though it still works.

## 1. Install prerequisites

- **Bun** — https://bun.sh/docs/installation#windows
- **ripgrep** — required by the grep tool:
  - Scoop: `scoop install ripgrep`
  - Chocolatey: `choco install ripgrep`
  - Or download from https://github.com/BurntSushi/ripgrep/releases

## 2. Clone and link

```powershell
git clone https://github.com/Kristos/telemachus.git
cd telemachus
bun install
bun link
```

Verify:

```powershell
tm --help
```

## 3. Shell selection

By default, the `bash` tool runs commands via `cmd /c` on Windows. To use PowerShell instead:

```powershell
# PowerShell
$env:KC_SHELL = "powershell"
```

```cmd
:: cmd.exe
set KC_SHELL=powershell
```

## WSL fallback

If you prefer a full bash environment, install WSL and run Telemachus inside it. The `bash` tool will use the real `bash` binary automatically.

## What's Windows-safe

| Component | Status |
|-----------|--------|
| `bash` tool | ✅ Uses cmd.exe or PowerShell via `KC_SHELL` |
| File tools (read/write/edit) | ✅ Use cross-platform `path` APIs |
| `grep` tool | ✅ Uses ripgrep with Windows-safe path resolution |
| `glob` tool | ✅ Cross-platform glob patterns |
| Session persistence | ✅ Atomic writes via tmp+rename |
| MCP servers | ✅ Inherits platform support from server itself |
| Local LLMs (Ollama, LM Studio) | ✅ Pure HTTP, platform-independent |
