---
title: Local LLMs
description: Run Telemachus against Ollama, LM Studio, or llama.cpp — free and private.
---

Telemachus supports any OpenAI-compatible local LLM server. The most common is [Ollama](https://ollama.com).

## Ollama

### 1. Install and pull a model

```bash
# macOS / Linux
brew install ollama
ollama serve &
ollama pull qwen2.5-coder:7b
```

Windows: download the installer from [ollama.com/download](https://ollama.com/download).

### 2. Configure Telemachus

Edit `~/.telemachus/config.json`:

```json
{
  "provider": "ollama",
  "model": "qwen2.5-coder:7b",
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434/v1" }
  }
}
```

Or switch from inside a session:

```
/model
```

### 3. Run

```bash
tm
```

No API key needed — everything runs locally.

## LM Studio

LM Studio exposes an OpenAI-compatible server on `http://localhost:1234/v1` by default. Use the same config pattern as Ollama but change the `baseUrl`:

```json
"ollama": { "baseUrl": "http://localhost:1234/v1" }
```

(The provider key is still `ollama` — it's the family of OpenAI-compatible providers, not the specific backend.)

## Known limitation: streaming + tool calls

Ollama's OpenAI compatibility layer silently drops tool calls when `stream: true` is set. Telemachus detects this at runtime and falls back to non-streaming mode for turns that include tools. Plain text turns still stream normally.

See [Ollama #9632](https://github.com/ollama/ollama/issues/9632) and [#12557](https://github.com/ollama/ollama/issues/12557) for upstream status.

## Token counts

OpenAI-compatible providers don't always return accurate `usage` fields. Telemachus falls back to `gpt-tokenizer` estimates so the status bar stays meaningful.

## llama.cpp on a beefy GPU

If you have a discrete GPU (especially a recent NVIDIA card), llama.cpp gives
you the best throughput and the most control. Telemachus has a dedicated
`llamacpp` provider — see [llama.cpp + Local GPU](/guides/llama-cpp/) for
build flags, model recipes, and how to expose your rig over Tailscale so you
can use it from any laptop, anywhere.

## Platform coverage

| OS | Ollama | LM Studio | llama.cpp |
|----|--------|-----------|-----------|
| macOS | ✅ | ✅ | ✅ |
| Linux | ✅ | ✅ | ✅ |
| Windows (native) | ✅ | ✅ | ✅ |

Local LLM support is pure HTTP — it works identically on every platform Telemachus runs on.
