# Bonsai Harness Features

## Beta capabilities

| Capability | Status | Evidence surface |
| --- | --- | --- |
| Backend health endpoint | Beta | `GET /health` reports service, claimed port, active agents, MCP connections, model, runtime kind, runtime-safe configuration, and sandbox root. |
| WebSocket event stream | Beta | Frontend connects to backend WebSocket and renders status, inference, exit, MCP, sandbox, and error events. |
| Local command runtime | Beta | Backend spawns `HARNESS_RUNNER_BINARY` with `HARNESS_RUNNER_ARGS_TEMPLATE`; smoke mode uses `/bin/echo`. |
| OpenAI-compatible API runtime | Beta | Backend can call `/v1/chat/completions`-style APIs with `HARNESS_API_*`; API keys remain server-side and are never accepted from the browser. |
| Spawn capacity limit | Beta | `HARNESS_MAX_ACTIVE_AGENTS` validates integer range `1..16`; default is `2`. |
| Sandbox writes | Beta | `write_sandbox` sanitizes filenames and writes under `HARNESS_SANDBOX_ROOT`. |
| Frontend runtime config | Beta | `VITE_HARNESS_BACKEND_URL` derives HTTP/WS backend URL without hardcoded forbidden port `3000`; operator form sends arbitrary `modelId` and runtime kind. |
| Malformed WebSocket handling | Beta | Frontend catches bad backend JSON events and logs an operator-visible error. |
| launchd operation | Beta | Plist sets claimed port, sandbox root, safe launchd stdio paths, and file descriptor resource limits; runtime logs still land in `logs/`. |
| CI verification | Beta | `.github/workflows/beta-ci.yml` installs deps, typechecks backend, tests backend, lints frontend, and builds frontend. |
| Docker beta runtime | Beta | Root Dockerfile runs backend on port `11431`; compose adds Vite frontend on `11432`. |

## Explicit beta limits

- No authentication or multi-user authorization.
- No durable job queue; spawned agents are in-memory child processes.
- No production-grade model lifecycle management.
- No browser E2E test suite yet.
- No hosted deployment target yet.
- No root Git repository was detected during the beta cutover, so release evidence is file-based rather than commit-based.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `11431` | Backend HTTP/WebSocket port; must be `10000..65535`. |
| `HARNESS_MODEL_ID` | `prism-ml/Ternary-Bonsai-8B-mlx-2bit` | Default model ID; Bonsai is the default value, not a hardcoded runtime identity. |
| `HARNESS_RUNTIME_KIND` | `local-command` | Default runtime adapter, either `local-command` or `openai-compatible`. |
| `HARNESS_MAX_ACTIVE_AGENTS` | `2` | Concurrency limit for active spawned workers. |
| `HARNESS_SANDBOX_ROOT` | `/Volumes/SanDisk1Tb/bonsai-harness/sandbox` | Root for sanitized sandbox writes. |
| `HARNESS_RUNNER_BINARY` | `/opt/homebrew/bin/mlx_lm` | Executable used by the local command runtime. |
| `HARNESS_RUNNER_ARGS_TEMPLATE` | `generate --model {{modelId}} --prompt {{prompt}} --verbose False` | Argument template for local command runtime. |
| `HARNESS_MODEL_CACHE_DIR` | `/Volumes/SanDisk1Tb/HFModels` | Model/tokenizer cache path exported as `HF_HOME` for local runners. |
| `HARNESS_CACHE_DIR` | `/Volumes/SanDisk1Tb/mlx-cache` | Runtime cache path exported as `MLX_CACHE_DIR` for local runners. |
| `HARNESS_API_BASE_URL` | unset | OpenAI-compatible API origin for API runtime. |
| `HARNESS_API_KEY` | unset | Server-side API credential; never expose through `VITE_` env. |
| `VITE_HARNESS_BACKEND_URL` | `http://localhost:11431` | Frontend build/dev backend endpoint. |
