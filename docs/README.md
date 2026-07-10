# Bonsai Harness

Bonsai Harness is a single-operator local agent harness for OpenAI-compatible and native Anthropic APIs. It runs provider requests on the backend, keeps API keys out of the browser bundle, supports registry-backed MCP stdio servers, and exposes a same-origin OpenCode Zen relay for browser-originated OpenAI-compatible requests.

## Supported runtimes

- `openai-compatible` — any Chat Completions-compatible API. The default base URL is `https://api.openai.com`; both `/v1/chat/completions` and `/chat/completions` work when the base URL already ends in `/v1`.
- `anthropic` — Anthropic Messages API (`/v1/messages`).

The legacy MLX/local-command runtime is intentionally not supported. A broken local model no longer blocks API-backed use.

## Run locally

```bash
cd backend && bun install --frozen-lockfile
cd ../frontend && bun install --frozen-lockfile
cd ..

cp backend/.env.example backend/.env.local
# Set a real provider key in backend/.env.local. Do not put it in frontend/.env.

bun run backend:dev
bun run frontend:dev
```

The backend listens on `127.0.0.1:11431` by default. The Vite dashboard runs on `127.0.0.1:11432` and proxies `/health`, `/api`, `/mcp`, `/gateway`, and `/ws` to the backend. The browser therefore uses same-origin paths only.

The supplied Compose configuration also publishes both ports to `127.0.0.1` only. It accepts either provider's environment variables, but the backend refuses agent execution until the key for the selected runtime is configured. Do not change the host-port bindings to a network interface unless you add a separate authentication boundary.

## OpenCode Zen

Set the OpenAI-compatible provider to:

```dotenv
HARNESS_RUNTIME_KIND=openai-compatible
HARNESS_API_BASE_URL=https://opencode.ai/zen/v1
HARNESS_API_PATH=/v1/chat/completions
HARNESS_API_KEY=replace-with-your-key
HARNESS_MODEL_ID=replace-with-a-model-id
```

For browser-side OpenCode calls, `frontend/src/api.ts` detects only the exact `https://opencode.ai/zen/v1` path boundary and sends a JSON envelope to the same-origin `/gateway` route. The backend relay accepts only `GET` and `POST`, forwards only an allowlisted set of headers, enforces a 120-second timeout, and refuses every other upstream host or path. It exists because the Zen gateway does not provide the browser CORS headers required for direct fetches.

## MCP

`GET /api/mcp/servers` exposes an availability-aware summary of the local MCP registry. An operator can connect an installed server from the dashboard; the backend performs MCP stdio `initialize`, `notifications/initialized`, and paginated `tools/list` before it makes the tools available to agents.

Connected tools are translated into OpenAI function tools or Anthropic tool definitions. The default safety mode is **Always Ask**: each tool call is shown only to the initiating dashboard WebSocket and requires explicit approval. `plan`, `auto`, and `yolo` are available only as deliberate per-run modes. Tool results are size-bounded before they return to a provider.

## Verify

```bash
bun run verify:beta
```

This runs backend typechecking and tests, frontend linting and API-boundary tests, then the production frontend build. For a configured provider, run `HARNESS_SMOKE_URL=http://127.0.0.1:11431 bun run provider:e2e`.

See [QUICKSTART.md](QUICKSTART.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CHEATSHEET.md](CHEATSHEET.md), and [api/openapi.yaml](api/openapi.yaml) for the operational contract.
