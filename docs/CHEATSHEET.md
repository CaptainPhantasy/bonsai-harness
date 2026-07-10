# Harness Cheatsheet

## Commands

```bash
bun run backend:dev
bun run frontend:dev
bun run backend:typecheck
bun run backend:test
bun run frontend:lint
bun run frontend:test
bun run frontend:build
bun run verify:beta
HARNESS_SMOKE_URL=http://127.0.0.1:11431 bun run smoke
HARNESS_SMOKE_URL=http://127.0.0.1:11431 bun run provider:e2e
```

## Runtime variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `11431` | Backend port |
| `HARNESS_BIND_HOST` | `127.0.0.1` | Backend bind address; use `0.0.0.0` only for a deliberate container publish |
| `HARNESS_ALLOWED_ORIGINS` | `http://127.0.0.1:11432,http://localhost:11432` | Comma-separated browser WebSocket origins |
| `HARNESS_RUNTIME_KIND` | `openai-compatible` | `openai-compatible` or `anthropic` |
| `HARNESS_MODEL_ID` | `gpt-4o-mini` | Model identifier for the selected provider |
| `HARNESS_API_BASE_URL` | `https://api.openai.com` | OpenAI-compatible base URL |
| `HARNESS_API_PATH` | `/v1/chat/completions` | OpenAI-compatible path |
| `HARNESS_API_KEY` | none | Server-side OpenAI-compatible key |
| `ANTHROPIC_API_BASE_URL` | `https://api.anthropic.com` | Anthropic base URL |
| `ANTHROPIC_API_KEY` | none | Server-side Anthropic key |
| `HARNESS_MAX_ACTIVE_AGENTS` | `2` | Maximum concurrent agents, from 1 through 64 |
| `HARNESS_SANDBOX_ROOT` | project sandbox | Destination for validated sandbox writes |
| `HARNESS_LOG_DIR` | project `logs/` directory | Local launcher log destination; containers log to stdout |
| `HARNESS_BACKEND_PROXY_TARGET` | `http://127.0.0.1:11431` | Vite development proxy target; not bundled into browser code |

Compose publishes `127.0.0.1:11431` and `127.0.0.1:11432` only. The backend binds to `0.0.0.0` inside that isolated container network so the frontend container can proxy requests; it is not exposed on the host network.

## HTTP routes

| Route | Method | Purpose |
|---|---|---|
| `/health` | `GET` | Runtime-safe health configuration and active counts |
| `/gateway` | `POST` | Fixed OpenCode Zen browser relay |
| `/api/settings` | `GET`, `PUT` | Provider configuration snapshot/update; never returns keys |
| `/api/mcp/servers` | `GET` | Registry summaries with availability and connection status |
| `/api/mcp/servers/:name/connect` | `POST` | Initialize and discover one installed MCP server |
| `/api/mcp/servers/:name` | `DELETE` | Disconnect one MCP server |

## WebSocket actions

```json
{ "action": "spawn_agent", "agentId": "Worker-1", "prompt": "Review this", "modelId": "provider-model", "runtimeKind": "openai-compatible", "safetyMode": "ask" }
{ "action": "send_message", "payload": "Review this", "safetyMode": "ask" }
{ "action": "resolve_tool_approval", "requestId": "uuid", "approved": true }
{ "action": "stop_generation" }
```

The backend sends `tool_approval_required` only to the WebSocket that started the agent. A different socket cannot resolve the request.
