---
title: llama.cpp + Local GPU
description: Run Telemachus against llama.cpp on a beefy GPU rig — locally and over Tailscale.
---

Telemachus ships a first-class `llamacpp` provider. It's a thin wrapper around
the OpenAI-compatible provider with sane defaults so you can point at a llama.cpp
server (local or remote) without thinking about the wire format.

This guide walks through:

1. Picking a model that fits your GPU
2. Building and launching `llama-server` with the right flags
3. Pointing Telemachus at it
4. Exposing the rig over **Tailscale** so you can use it from a laptop anywhere

## TL;DR config

Edit `~/.telemachus/config.json`:

```json
{
  "provider": "llamacpp",
  "model": "GLM-4.7-Flash-Q4_K_M.gguf",
  "providerConfigs": {
    "llamacpp": {
      "model": "GLM-4.7-Flash-Q4_K_M.gguf",
      "baseURL": "http://localhost:8080/v1",
      "apiKey": "sk-pickAlongRandomString"
    }
  }
}
```

> **The `model` value must match what `llama-server` exposes at `/v1/models`** —
> typically the GGUF filename, not a friendly name. Curl your endpoint to confirm:
> `curl http://localhost:8080/v1/models` and copy the `id` from the response.

Then start `llama-server` with the flags from the recipe below for your model
and run `tm`. Switch models mid-session with `/model`.

## Picking a model (16 GB VRAM tier)

These three are the strong picks for an agent workload on a 5070 Ti / 4080-class
card. All three support tool calling and have good llama.cpp Jinja templates.

| Model | Params | Active | Quant | VRAM | Notes |
|---|---|---|---|---|---|
| **GLM-4.7-Flash** | 30B (MoE) | ~3B | Q4_K_M | ~14 GB | Best agent default. ~80 tok/s. Great tool calling. |
| **Qwen3-Coder-Next** | 80B (MoE) | ~3B | IQ4_XS / Q3_K_M | 14 GB + RAM offload | Highest quality ceiling. Use `--n-cpu-moe` to spill experts to DDR5. |
| **GPT-OSS 20B** | 20B (dense) | 20B | Q4_K_M | ~13.7 GB | Fastest of the three. ~42 tok/s. Best when you want snappy. |

Get GGUFs from [Unsloth on Hugging Face](https://huggingface.co/unsloth) — they
publish well-tested quants with up-to-date Jinja chat templates.

## Building llama.cpp for Blackwell (5070 Ti)

The 5070 Ti is `sm_120`. You need CUDA 12.8 or newer.

### Windows (native, recommended for the rig)

```powershell
# Prereqs: Visual Studio 2022 with C++ workload, CUDA Toolkit 12.8+, CMake, git
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120
cmake --build build --config Release -j
# binary lands at build\bin\Release\llama-server.exe
```

### Linux (WSL2 or native)

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120
cmake --build build --config Release -j
```

> **Sanity check:** `./build/bin/llama-server --version` should print a build
> hash from 2026 or later. Tool-call streaming for Qwen3 / GLM-4.x landed in
> early 2026 — older builds will silently drop calls.

## Launch recipes

All commands assume `llama-server` is on your `$PATH` and models live in
`./models`. Adjust `--host` and `--port` as needed.

### Recipe A — GLM-4.7-Flash (the default)

```bash
llama-server \
  --model ./models/GLM-4.7-Flash-Q4_K_M.gguf \
  --jinja \
  --reasoning off \
  --ctx-size 32768 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --n-gpu-layers 999 \
  --flash-attn on \
  --batch-size 2048 \
  --ubatch-size 2048 \
  --parallel 1 \
  --host 0.0.0.0 \
  --port 8080 \
  --api-key sk-pickAlongRandomString
```

What the flags do:
- `--jinja` — load the model's bundled chat template (required for correct tool-call formatting)
- `--reasoning off` — **critical for thinking models like GLM-4.7-Flash**. Without
  this, the model burns 200–500+ reasoning tokens before producing any user-visible
  output, making interactive use feel sluggish. With it off, first-token latency
  drops by ~40x. See [Thinking models](#thinking-models) below.
- `--ctx-size 32768` — 32 K context. 64 K is tempting but the KV cache eats VRAM
  fast on a 16 GB card; 32 K is the sweet spot for tm-sized agent loops.
- `--cache-type-k/v q8_0` — quantize the KV cache to Q8, halves memory at no perceivable quality loss
- `--n-gpu-layers 999` — push every layer to the GPU
- `--flash-attn on` — Flash Attention 2 (recent llama.cpp builds require explicit `on`/`off`/`auto`)
- `--batch-size 2048 --ubatch-size 2048` — bigger batches accelerate the cold prompt-processing pass that tm takes the first time it sends its 161-MCP-tool system prompt
- `--parallel 1` — single user, maximises prompt cache reuse across turns
- `--host 0.0.0.0` — bind all interfaces (the Windows Firewall rule below restricts to the Tailscale interface)
- `--api-key` — defense-in-depth bearer-token auth on top of the firewall

### Recipe B — Qwen3-Coder-Next 80B (expert offload)

This is the stretch pick. 32 GB DDR5 is enough RAM to spill the inactive
experts off-GPU.

```bash
llama-server \
  --model ./models/Qwen3-Coder-Next-IQ4_XS.gguf \
  --jinja \
  --ctx-size 32768 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --n-gpu-layers 999 \
  --n-cpu-moe 40 \
  --flash-attn \
  --parallel 1 \
  --host 0.0.0.0 \
  --port 8080
```

The key flag is `--n-cpu-moe 40` — keeps attention and shared layers on the
GPU but spills 40 expert FFN tensors to system RAM. Tune the number until VRAM
sits around 14–15 GB. Expect 10–20 tok/s; the win is the much higher quality
ceiling on long-horizon tasks.

> Newer llama.cpp builds support `--override-tensor` patterns instead, which
> give finer-grained control. `--n-cpu-moe N` is the simpler knob.

### Recipe C — GPT-OSS 20B (the speed pick)

```bash
llama-server \
  --model ./models/gpt-oss-20b-Q4_K_M.gguf \
  --jinja \
  --ctx-size 32768 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --n-gpu-layers 999 \
  --flash-attn \
  --parallel 1 \
  --host 0.0.0.0 \
  --port 8080
```

Dense model, simpler to reason about, snappiest of the three. Use this when
you want telemachus to *feel* fast in interactive use.

## Thinking models

GLM-4.7-Flash, DeepSeek-R1, QwQ, and friends are *thinking* models — they emit
hidden reasoning tokens (sometimes hundreds) before producing any user-visible
content. This is great for chain-of-thought benchmarks but **terrible for
interactive agent loops**, where every turn takes 10–30 s of thinking before
the first character lands.

llama.cpp gives you three knobs:

| Flag | Effect |
|---|---|
| `--reasoning auto` (default) | Honour the model's training — full thinking enabled |
| `--reasoning off` | Suppress the thinking phase entirely. **Recommended for tm.** |
| `--reasoning-budget N` | Cap thinking to `N` tokens (`-1` unlimited, `0` immediate end) |

For an agent loop, `--reasoning off` is almost always the right answer. Tool
calling still works perfectly — the model just skips the internal monologue.
If you want the best of both worlds, use `--reasoning-budget 256` to allow a
short reasoning burst without runaway latency.

> **Cold start tax.** Even with thinking off, the *first* message in a fresh
> tm session still pays the cost of processing the full system prompt + every
> MCP tool schema. With tm's typical 161-tool inventory that's ~10–20 K tokens
> processed at ~50 tok/s = several seconds. Subsequent messages reuse the
> prompt cache and feel instant.

## Tailscale remote access

This is the killer move: run `llama-server` on your Windows rig at home, then
use telemachus from your MacBook anywhere — coffee shop, hotel, train —
exactly as if the model were local. Tailscale handles the WireGuard tunnel and
NAT traversal; you don't expose anything to the public internet.

### One-time setup

1. **Install Tailscale** on both machines and join them to the same tailnet.
2. **Find the Windows machine's tailnet name** in the Tailscale tray app —
   something like `windowsbox.tail-scale-name.ts.net`.
3. **Allow inbound 8080 on the Tailscale interface only.** On Windows, run
   PowerShell as admin:

   ```powershell
   New-NetFirewallRule `
     -DisplayName "llama.cpp via Tailscale" `
     -Direction Inbound `
     -Protocol TCP `
     -LocalPort 8080 `
     -InterfaceAlias "Tailscale" `
     -Action Allow
   ```

   This rule binds the open port to the `Tailscale` adapter only — your LAN
   and public interfaces remain closed.

4. **Add a llama.cpp API key** as defense in depth. Restart `llama-server` with:

   ```bash
   llama-server ... --api-key "sk-pickAlongRandomString"
   ```

### Point Telemachus at the rig

On your MacBook, edit `~/.telemachus/config.json`:

```json
{
  "provider": "llamacpp",
  "model": "GLM-4.7-Flash-Q4_K_M.gguf",
  "providerConfigs": {
    "llamacpp": {
      "model": "GLM-4.7-Flash-Q4_K_M.gguf",
      "baseURL": "http://windowsbox.tail-scale-name.ts.net:8080/v1",
      "apiKey": "sk-pickAlongRandomString"
    }
  }
}
```

The `model` value must match the `id` returned by `/v1/models` on your rig —
which is usually the GGUF filename, *not* a friendly name. Confirm with:

```bash
curl -H "Authorization: Bearer sk-pickAlongRandomString" \
  http://windowsbox.tail-scale-name.ts.net:8080/v1/models
```

Or set it ad-hoc with an env var (handy when toggling between local and remote):

```bash
export KC_LLAMACPP_BASE_URL="http://windowsbox.tail-scale-name.ts.net:8080/v1"
tm
```

That's it. `tm` works the same wherever you are.

### Latency notes

- WireGuard adds ~5–30 ms over LAN, ~30–80 ms from a coffee shop.
- The bottleneck is generation, not network — at 80 tok/s the model dominates.
- TTFT will feel slightly worse remotely, but interactive feel stays good.

### Optional: keep the server running

The cleanest pattern on Windows is a **scheduled task running as `SYSTEM`** at
boot — that way the rig comes up after a reboot and llama-server is ready
before you SSH or `tm` in. Drop your launch command into a `.bat` file and
register the task from an admin PowerShell:

```powershell
$action  = New-ScheduledTaskAction -Execute cmd.exe -Argument '/c C:\ai\start-llama-server.bat'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName LlamaServer -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
```

To stop / start later:

```powershell
Stop-Process -Name llama-server -Force      # stop
Start-ScheduledTask -TaskName LlamaServer   # start
```

Alternative: [NSSM](https://nssm.cc/) wraps any binary as a Windows service.

## Benchmarking

Telemachus ships a benchmark harness that hits any OpenAI-compatible endpoint
with five agent-style scenarios: cold throughput, single tool call, tool
disambiguation, multi-turn coherence, and long-context recall.

```bash
# Local
bun run scripts/bench-local.ts \
  --base-url http://localhost:8080/v1 \
  --model glm-4.7-flash

# Remote rig over Tailscale
bun run scripts/bench-local.ts \
  --base-url http://windowsbox.tail-scale-name.ts.net:8080/v1 \
  --model glm-4.7-flash \
  --api-key sk-pickAlongRandomString

# JSON output for diffing two runs
bun run scripts/bench-local.ts ... --json > glm.json
bun run scripts/bench-local.ts ... --json > qwen.json
diff glm.json qwen.json
```

The harness reports TTFT, generation tok/s, and pass/fail per scenario — so
you can compare GLM-4.7-Flash vs Qwen3-Coder-Next on your actual hardware
rather than trusting marketing benchmarks.

## Troubleshooting

**`tool_calls` come back empty.** Your llama.cpp build is too old or you forgot
`--jinja`. Rebuild against latest `master` and pass `--jinja`.

**VRAM blows up partway through generation.** KV cache. Lower `--ctx-size` or
make sure both `--cache-type-k` and `--cache-type-v` are `q8_0`.

**Model loads but generates gibberish.** Wrong chat template — re-pull the
GGUF from a maintainer who ships the template (Unsloth, bartowski) and pass
`--jinja`.

**Slow on Blackwell.** Verify CUDA 12.8+, `CMAKE_CUDA_ARCHITECTURES=120`, and
that `--flash-attn on` is set. Disable Windows hardware-accelerated GPU scheduling
if you see stutters under load.

**Tailscale connection works but telemachus hangs.** Confirm
`curl http://windowsbox.tail-scale-name.ts.net:8080/v1/models` from the
MacBook returns JSON. If not, the Windows firewall rule is wrong — re-check
the `-InterfaceAlias "Tailscale"` line.

**`error: unknown value for --flash-attn: '--parallel'`.** Recent llama.cpp
builds require an explicit value for `--flash-attn` (use `on`, `off`, or `auto`).
Bare `--flash-attn` swallows the next CLI arg as its value.

**First message takes forever, subsequent messages are fast.** Two things stack:
(1) the model is a *thinking* model and is burning reasoning tokens — set
`--reasoning off`; (2) cold prompt-cache pass over tm's full MCP tool inventory.
The cold tax is fundamental — see [Thinking models](#thinking-models).

**`{"error":{"message":"Loading model","type":"unavailable_error","code":503}}`.**
Server is still loading the model into VRAM. With Q4 GLM-4.7-Flash on a 16 GB
card this can take 20–40 s. Poll `/v1/models` until it returns 200.

**`401 Incorrect API key provided`.** Either your tm config has a stale
`apiKey`, or it's still pointing at the default `localhost:8080` and your real
endpoint is somewhere else. Check `~/.telemachus/config.json` —
`providerConfigs.llamacpp.apiKey` and `baseURL` must both match the running
server. Note: tm's older versions had a routing bug that mis-sent ollama
selections to `api.openai.com`; if you see `api.openai.com` in the error, you're
on a pre-fix version — pull latest.

**`tm` says "model not found".** The `model` field in your config must match
the exact `id` returned by `/v1/models`, which is usually the GGUF filename
(`GLM-4.7-Flash-Q4_K_M.gguf`), not a friendly name (`glm-4.7-flash`).

## Appendix: Installing the toolchain over SSH

If you're setting up the rig remotely (e.g. SSH'ing from a MacBook to a Windows
machine), there are a few sharp edges that aren't obvious:

**Windows OpenSSH and admin accounts.** When a user is in the `Administrators`
group, sshd reads `C:\ProgramData\ssh\administrators_authorized_keys` and
**ignores** the user's `~/.ssh/authorized_keys`. If you add a key to a user
file and then promote the user to admin, key auth will silently break. Always
write to `administrators_authorized_keys` for admin users:

```powershell
Add-Content C:\ProgramData\ssh\administrators_authorized_keys -Value 'ssh-ed25519 AAAA...'
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" "SYSTEM:F"
```

**The Visual Studio Build Tools installer over SSH.** It works, but it lies.
The bootstrapper detaches itself, the install runs in the background, and
`Start-Process -Wait` may return *long* before anything visible happens. Cache
size and process listings often show no progress for several minutes even
though the install is succeeding. Be patient — a successful VS Build Tools
install over SSH typically takes 15–25 minutes wall-clock.

The most reliable invocation pattern is to run the installer via a **scheduled
task as SYSTEM**, not directly from your SSH session, because the installer
tries to spawn UI-hosting child processes that can't render in an interactive
SSH context:

```powershell
$a = New-ScheduledTaskAction -Execute cmd.exe -Argument '/c C:\Installers\install-vs.bat'
$p = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName VSInstall -Action $a -Principal $p -Settings $s -Force
Start-ScheduledTask -TaskName VSInstall
```

Inside `install-vs.bat`, **avoid PowerShell `Start-Process -ArgumentList @(...)`**
when args contain spaces — the array form mangles paths like
`C:\Program Files (x86)\...`. Use a plain `.bat` invocation instead:

```bat
@echo off
"C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify ^
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" ^
  --add Microsoft.VisualStudio.Workload.VCTools ^
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 ^
  --add Microsoft.VisualStudio.Component.Windows11SDK.22621 ^
  --quiet --wait --norestart
```

Verify success by looking for `cl.exe`:

```powershell
Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe"
```

**CUDA Toolkit 12.8 silent install** is well-behaved by comparison. The
network installer is small (~14 MB) and pulls components on demand:

```bat
@echo off
"C:\Installers\cuda_12.8.0_windows_network.exe" -s
```

Takes ~7 minutes wall-clock for the components needed by llama.cpp.

**`llama-server.exe` launch via cmd.exe.** Caret-continuation parsing in
`.bat` files is fragile when long arg lists meet certain flag values. If you
see `'something' is not recognized as an internal or external command`,
collapse your launch script into a **single long line** with no `^`
continuations — it's uglier but reliable.
