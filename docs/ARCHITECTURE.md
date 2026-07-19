# Architecture

## Topology

```text
Browser at 127.0.0.1:11432
  ├─ same-origin fetch: /health, /api/*, /mcp/*, /gateway
  └─ same-origin WebSocket: /ws
              │
              ▼ Vite development proxy
Harness backend at 127.0.0.1:11431
  ├─ OpenAI-compatible adapter ──► configured provider
  ├─ Anthropic Messages adapter ─► configured provider
  ├─ fixed /gateway relay ───────► https://opencode.ai/zen/v1 only
  ├─ MCP manager ────────────────► allowlisted local stdio process
  └─ sandbox writer ─────────────► HARNESS_SANDBOX_ROOT
```

The production deployment contract is the same: put the frontend and backend behind one reverse-proxy origin, and configure `HARNESS_ALLOWED_ORIGINS` to that origin. Vite’s proxy exists only for local development.

## Backend

`backend/server.ts` is the Bun entry point. It owns the HTTP/WebSocket boundary, active-agent lifecycle, provider tool loop, approval queue, and graceful shutdown. The backend defaults to `127.0.0.1`; `0.0.0.0` is an explicit container-only choice.

`backend/src/server-core.ts` defines the two runtime kinds and validates provider/settings input before it can enter `backend/.env.local`. API keys are never returned by `readSettingsSnapshot` or the health endpoint.

### Provider execution

OpenAI-compatible requests use Chat Completions message and function-tool shapes. Native Anthropic requests use Messages API content blocks and tool definitions. Both adapters:

1. snapshot connected MCP tools when an agent begins;
2. send a provider request with those tools;
3. validate provider tool calls;
4. apply the selected safety policy;
5. call MCP only after approval where required;
6. append a bounded tool result; and
7. stop after eight tool rounds or a 60-second agent timeout.

## OpenCode Zen relay

`backend/src/opencode-gateway.ts` is intentionally independent of the server entry point so its security contract is unit-tested. It accepts a local JSON envelope only through `POST /gateway`, requires the exact `https://opencode.ai/zen/v1` origin/path boundary, supports only `GET` and `POST`, forwards only `authorization`, `content-type`, `accept`, and `x-api-key`, and returns a bounded error without upstream details.

`frontend/src/api.ts` is the only browser fetch wrapper. OpenCode Zen URLs are sent to relative `/gateway`; all regular harness calls remain relative. This prevents a direct browser fetch to a gateway that lacks CORS headers.

## MCP

`backend/src/mcp-registry.ts` is an inventory, not an implicit permission grant. It marks unavailable local entry points before a spawn attempt. `backend/src/mcp-client.ts` implements newline-delimited JSON-RPC over stdio: `initialize`, `notifications/initialized`, paginated `tools/list`, `tools/call`, timeout cleanup, and process shutdown.

Tool approval is bound to the WebSocket which started the agent. The default `ask` mode requires approval for every tool. `auto` permits only conservatively classified read tools; `plan` blocks non-read tools; `yolo` is an explicit no-approval mode. MCP tool names are scoped with their server name before being exposed to providers.

## State and limits

- Agent, MCP connection, and approval state is process-local and is lost on backend restart.
- Browser conversations and preferences live in browser `localStorage`.
- The backend has no user authentication because it is a loopback local-operator service. Do not expose it to an untrusted network.
- MCP results passed to providers are capped at 100,000 characters; tool arguments shown for approval are capped at 4,000 characters.
