# Beta Release Standard

Bonsai Harness reaches beta when a local operator can install dependencies, start the backend on an allowed claimed port, run the frontend against it, verify the smoke spawn path, and understand the remaining non-production gaps from repository artifacts alone.

## Required beta gates

| Gate | Requirement | Verification |
| --- | --- | --- |
| Port governance | No runtime source/config defaults to forbidden port `3000`; backend uses claimed port `11431`. | Search for `localhost:3000` and `PORT:-3000`; inspect `/Volumes/SanDisk1Tb/SSOT/port-registry.json`. |
| Backend correctness | Core helpers validate port, sandbox root, generic runtime config, local command args, API request construction, capacity, parsing, and health payload. | `cd backend && bun test`. |
| Backend type safety | Strict TypeScript checks pass. | `cd backend && bunx tsc --noEmit`. |
| Frontend quality | React dashboard lints and production build completes. | `cd frontend && bun run lint && bun run build`. |
| Smoke operation | `/health` responds and WebSocket spawn emits inference or exit in smoke mode. | `HARNESS_RUNNER_BINARY=/bin/echo HARNESS_RUNNER_ARGS_TEMPLATE='{{runtimeKind}} --model {{modelId}} --prompt {{prompt}}' PORT=11431 bun run backend:dev` plus `HARNESS_SMOKE_URL=http://localhost:11431 bun run smoke`. |
| launchd readiness | LaunchAgent plist parses, exports beta env, and raises file descriptor limits. | `plutil -lint launchd/com.legacyai.bonsaiharness.plist`. |
| Operator handoff | Root docs, feature list, changelog, OpenAPI, Docker, compose, and CI workflow exist. | File inspection. |

## Environment caveat

On this workstation, launchd can parse and load the plist but macOS System Policy denies background Bun reads from `/Volumes/SanDisk1Tb/bonsai-harness` unless the host process has the needed external-volume access. Manual backend and smoke verification remain the beta runtime proof.

## Stop line

Do not treat beta as production. Stop before adding auth, hosted deployment, distributed queues, full observability, or enterprise policy engines unless a later user request explicitly expands the scope.
