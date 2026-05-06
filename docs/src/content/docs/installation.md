---
title: Installation
description: Install Telemachus from source or build a standalone binary.
---

## Requirements

- [Bun](https://bun.sh) 1.3+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (for the `grep` tool)
- macOS, Linux, or Windows (native)

## From source

```bash
git clone git@github.com:Kristos/telemachus.git
cd telemachus
bun install
bun link
```

Verify:

```bash
which tm   # should point at your bun global bin
tm --help
```

## Compiled binary

```bash
bun run build:compile
./tm
```

Produces a single `~60 MB` executable that runs without Bun installed. The binary is OS/arch specific — build it on the machine you plan to run it on.

## Platform notes

| Platform | Status |
|----------|--------|
| macOS | ✅ Primary dev platform |
| Linux | ✅ Works identically to macOS |
| Windows (native) | ✅ As of v1.1 — see [Windows setup](/guides/windows/) |
| Windows (WSL / Git Bash) | ✅ Works — `bash` detected automatically |
