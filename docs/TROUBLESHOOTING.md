# Troubleshooting

## The dashboard cannot connect

1. Confirm the backend is loopback-bound and healthy:

   ```bash
   curl -sS http://127.0.0.1:11431/health
   lsof -nP -iTCP:11431 -sTCP:LISTEN
   ```

2. Start the frontend with `bun run frontend:dev`; it proxies same-origin paths to `HARNESS_BACKEND_PROXY_TARGET` (default `http://127.0.0.1:11431`).
3. If the browser WebSocket receives HTTP 403, add the actual dashboard origin to `HARNESS_ALLOWED_ORIGINS`. The default allows `http://127.0.0.1:11432` and `http://localhost:11432`.

## The provider is not ready

`/health` returns `ok: false` and a non-secret `error` when the active runtime is missing a key or has an invalid value. Inspect the key-presence booleans through Settings, then verify the backend file:

```bash
grep -E 'HARNESS_RUNTIME_KIND|HARNESS_API_BASE_URL|HARNESS_MODEL_ID|ANTHROPIC_API_BASE_URL' backend/.env.local
```

Do not print or commit API keys. Use `bun run provider:e2e` only after the provider configuration is valid.

## OpenCode Zen requests fail in the browser

The browser must send OpenCode URLs through `/gateway`; direct fetches fail because the Zen gateway does not supply browser CORS headers. Confirm that the request URL in the browser is `/gateway`, then verify the fixed upstream with a local proxy check:

```bash
curl -i -X POST http://127.0.0.1:11431/gateway \
  -H 'content-type: application/json' \
  --data '{"targetUrl":"https://opencode.ai/zen/v1/models","method":"GET"}'
```

Any non-Zen target should return HTTP 400. The relay intentionally does not proxy arbitrary URLs.

## An MCP server is unavailable

The inventory marks an entry unavailable when its configured executable or entry point is missing. This is expected for machine-specific registry entries. Install or repair the server outside this repository, refresh the dashboard, and connect it explicitly.

If an installed MCP server fails during initialization, inspect its own stderr or launch it independently; the harness does not copy arbitrary MCP stderr into the browser because it can contain sensitive diagnostics.

## A tool call is waiting

In the default **Always Ask** mode, the initiating browser receives a Tool Approvals card. Approve or reject the exact arguments. Closing the initiating WebSocket stops its agents and rejects their pending approvals.

## Verification fails

Run the full local sequence:

```bash
bun run verify:beta
```

Address the first non-zero command. The gate covers backend typechecking/tests, frontend lint/API tests, and the production build.
