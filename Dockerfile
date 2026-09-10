FROM denoland/deno:alpine-2.9.6

WORKDIR /app

# Dependencies first, so a source change does not invalidate the cache.
COPY deno.json deno.lock* ./
COPY src ./src
COPY ui ./ui
COPY templates ./templates
COPY scripts ./scripts

# Warms the module cache. The container then needs no network at start.
RUN deno install --entrypoint src/main.ts && deno check src/main.ts

# The test templates import this. `deno test` runs with --no-config inside
# data/, so it resolves the full specifier and would otherwise download it at
# the first publish. Cache it here, and an offline container can still gate.
RUN deno cache "jsr:@std/assert@^1.0.10"

ENV LAMBDOCK_DATA=/data \
    LAMBDOCK_HOST=0.0.0.0 \
    LAMBDOCK_PORT=8000

# Functions, the env store and the key-value database live here. Mount a volume.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval --allow-net "const r = await fetch('http://127.0.0.1:8000/__/api/health').catch(() => null); Deno.exit(r?.ok ? 0 : 1)"

# --allow-run lets the editor type-check a function with `deno check`.
# Set LAMBDOCK_TYPECHECK=0 and drop the flag if you do not want that.
CMD ["run", \
     "--allow-net", \
     "--allow-read", \
     "--allow-write=/data", \
     "--allow-env", \
     "--allow-run", \
     "--unstable-kv", \
     "src/main.ts"]
