FROM oven/bun:1 AS deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
RUN mkdir -p /app/logs /app/sandbox && chown -R bun:bun /app
ENV NODE_ENV=production \
    PORT=11431 \
    HARNESS_MAX_ACTIVE_AGENTS=2 \
    HARNESS_SANDBOX_ROOT=/app/sandbox \
    HARNESS_RUNNER_BINARY=/bin/echo \
    HARNESS_RUNNER_ARGS_TEMPLATE="{{runtimeKind}} --model {{modelId}} --prompt {{prompt}}" \
    HARNESS_MODEL_CACHE_DIR=/app/models \
    HARNESS_CACHE_DIR=/app/mlx-cache
EXPOSE 11431
USER bun
WORKDIR /app/backend
CMD ["bun", "run", "server.ts"]
