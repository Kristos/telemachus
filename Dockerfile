# Why debian (not alpine):
#   bun compiled binaries are linked against glibc (GNU libc). Alpine uses musl
#   libc, which causes bun binaries to segfault at startup (bun issue #14292).
#   Both builder and runtime stages use glibc-based debian images.
#
# sandbox-exec (macOS-only):
#   The `sandbox-exec` tool wrapper in src/tools/sandbox/index.ts returns a
#   no-op passthrough on Linux — no extra configuration required in Docker.
#   Container isolation is provided by Docker itself. See DOCKER-05.

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Install dependencies first (cache-friendly layer)
COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

# Copy source and config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile to a single self-contained native binary
RUN bun build --compile src/index.ts --outfile /app/tm

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates: required for outbound HTTPS (Anthropic API, Discord, Telegram)
# curl: useful for health checks and container diagnostics
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Copy compiled binary and entrypoint from builder stage
COPY --from=builder /app/tm /usr/local/bin/tm
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /usr/local/bin/tm

WORKDIR /root

ENTRYPOINT ["/entrypoint.sh"]
