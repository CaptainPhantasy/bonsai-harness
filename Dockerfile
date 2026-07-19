FROM oven/bun:1 AS deps
WORKDIR /app/backend
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
RUN mkdir -p /app/sandbox && chown -R bun:bun /app
ENV NODE_ENV=production \
    PORT=11431 \
    HARNESS_BIND_HOST=0.0.0.0 \
    HARNESS_MAX_ACTIVE_AGENTS=2 \
    HARNESS_SANDBOX_ROOT=/app/sandbox \
    HARNESS_RUNTIME_KIND=openai-compatible \
    HARNESS_API_BASE_URL=https://api.openai.com \
    HARNESS_API_PATH=/v1/chat/completions \
    HARNESS_MODEL_ID=gpt-4o-mini
EXPOSE 11431
USER bun
WORKDIR /app/backend
CMD ["bun", "run", "server.ts"]
