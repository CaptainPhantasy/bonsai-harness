# Capability Inventory

| Capability | Status | Evidence surface |
|---|---|---|
| OpenAI-compatible execution | Implemented | `buildOpenAiCompatibleConversationRequest` and WebSocket agent loop |
| Native Anthropic execution | Implemented | `buildAnthropicConversationRequest` and WebSocket agent loop |
| OpenCode Zen compatibility | Implemented | `/v1` path normalization plus fixed `https://opencode.ai/zen/v1` gateway allowlist |
| Same-origin browser relay | Implemented | `frontend/src/api.ts`, Vite proxy, `POST /gateway` |
| Provider key isolation | Implemented | Backend-only environment variables and settings snapshot key-presence fields |
| MCP stdio lifecycle | Implemented | `initialize`, `notifications/initialized`, paginated `tools/list`, `tools/call` |
| MCP provider tools | Implemented | OpenAI function-tool and Anthropic tool adapters |
| MCP approval policy | Implemented | `plan`, `ask`, `auto`, and `yolo` modes; default `ask` |
| MCP registry availability | Implemented | Missing local entry points are marked unavailable before spawn |
| Loopback protection | Implemented | Backend defaults to `127.0.0.1`; browser WebSockets validate allowed origins |
| Backend contract tests | Implemented | `bun run backend:test` |
| Frontend API-boundary tests | Implemented | `bun run frontend:test` |

## Explicit limits

- The harness is a local, single-operator system. It is not multi-tenant and does not provide user authentication.
- Provider responses are non-streaming at the current adapter boundary; a completed response is broadcast as one inference event.
- MCP registry entries are machine-specific. An unavailable entry is intentionally not spawned.
- MCP calls are bounded to eight provider tool rounds per agent and tool results are capped before being returned to a provider.
- Deployment outside loopback requires an explicit `HARNESS_BIND_HOST=0.0.0.0` and a matching `HARNESS_ALLOWED_ORIGINS` configuration.
