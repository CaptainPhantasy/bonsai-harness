# Quickstart

## 1. Install dependencies

```bash
cd backend && bun install --frozen-lockfile
cd ../frontend && bun install --frozen-lockfile
cd ..
```

## 2. Configure one provider

Copy `backend/.env.example` to `backend/.env.local` and set exactly one active runtime.

OpenAI-compatible:

```dotenv
HARNESS_BIND_HOST=127.0.0.1
HARNESS_RUNTIME_KIND=openai-compatible
HARNESS_API_BASE_URL=https://api.openai.com
HARNESS_API_PATH=/v1/chat/completions
HARNESS_API_KEY=replace-with-server-side-key
HARNESS_MODEL_ID=gpt-4o-mini
```

OpenCode Zen uses the same runtime shape:

```dotenv
HARNESS_API_BASE_URL=https://opencode.ai/zen/v1
HARNESS_API_PATH=/v1/chat/completions
HARNESS_API_KEY=replace-with-server-side-key
HARNESS_MODEL_ID=replace-with-a-Zen-model-id
```

Native Anthropic:

```dotenv
HARNESS_RUNTIME_KIND=anthropic
ANTHROPIC_API_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=replace-with-server-side-key
HARNESS_MODEL_ID=replace-with-an-Anthropic-model-id
```

Never use `VITE_` for a provider key. The settings pane writes server-side settings to `backend/.env.local`.

## 3. Start the harness

In two terminals:

```bash
bun run backend:dev
```

```bash
bun run frontend:dev
```

Open `http://127.0.0.1:11432/bonsai/`. The frontend calls local relative routes; Vite proxies them to the backend. For Docker, set `HARNESS_BIND_HOST=0.0.0.0` only inside the container and set `HARNESS_ALLOWED_ORIGINS` to the dashboard’s real origin.

## 4. Verify a configured provider

```bash
HARNESS_SMOKE_URL=http://127.0.0.1:11431 bun run smoke
HARNESS_SMOKE_URL=http://127.0.0.1:11431 bun run provider:e2e
```

Both commands require the backend to be running with a working provider configuration. They verify `/health`, WebSocket spawn, inference output, and clean agent exit.

## 5. Connect MCP only when needed

The MCP Servers section lists every registry entry and marks missing entry points unavailable. Connect an installed server, choose a safety mode in Settings, and run the agent. In **Always Ask** mode, each provider-requested tool call shows its arguments and requires an explicit Approve or Reject action.

## 6. Run the complete gate

```bash
bun run verify:beta
```
