## 0.1.0-beta.2 - 2026-05-03

### Changed

- Smoke test timeout increased from 5s to 60s to accommodate real MLX model loading.
- Added `bonsai:e2e` script for real Bonsai model inference verification.
- Environment variable names normalized: `BONSAI_*` prefix removed in favor of `HARNESS_*`.
- Smoke test model ID uses `smoke/slm` (echo-safe) instead of real model ID.

### Verified

- Full `verify:beta` gate passes: typecheck (0 errors), 14 tests (0 fail), lint (0 errors), build (0 errors).
- Real Bonsai model (`prism-ml/Ternary-Bonsai-8B-mlx-2bit`) inference confirmed via WebSocket: `2+2=` → `2 + 2 = 4` in ~2.1s.
- Health endpoint reports `runnerBinaryPresent: true` for `/opt/homebrew/bin/mlx_lm`.
- Model cached at `HFModels/hub/models--prism-ml--Ternary-Bonsai-8B-mlx-2bit/`.

## 0.1.0-beta.1 - 2026-05-03
# Changelog

## 0.1.0-beta.1 - 2026-05-03

### Added

- Root beta operator README with architecture, setup, verification, launchd, API, and Docker instructions.
- Feature inventory and explicit beta limitations in `FEATURES.md`.
- OpenAPI 3.1 contract at `docs/api/openapi.yaml`.
- GitHub Actions beta verification workflow at `.github/workflows/beta-ci.yml`.
- Root `package.json` beta scripts for backend, frontend, smoke, and verification commands.
- Docker beta runtime via root `Dockerfile` and `docker-compose.yml`.
- Frontend Vite env typing and `.env.example` for `VITE_BONSAI_BACKEND_URL`.

### Changed

- Cut backend default port from forbidden `3000` to claimed governance port `11431`.
- Added frontend dev/preview port claim `11432` for beta operator UI.
- Backend health now reports the resolved port and sandbox root.
- Backend sandbox root can be overridden with `BONSAI_SANDBOX_ROOT` for containers and launchd.
- Frontend WebSocket URL is derived from `VITE_BONSAI_BACKEND_URL` instead of hardcoding `ws://localhost:3000`.
- LaunchAgent template now sets `PORT=11431`, safe `/tmp` launchd stdio paths, sandbox root, and file descriptor resource limits; the backend script redirects runtime logs into `logs/`.
- Smoke test defaults to `http://localhost:11431`.

### Fixed

- Backend unit test expectation for `buildSpawnArguments` now matches the actual MLX CLI contract: `eval --model <model> --prompt <prompt>`.
- Frontend no longer throws on malformed backend WebSocket JSON; it logs an operator-visible error.

### Known beta gaps

- No authn/authz layer.
- No durable process registry across backend restarts.
- No production deployment target.
- No browser E2E test suite.
- Active directory is not a Git repository, so commit and branch evidence are unavailable.

## 0.1.0-beta.3 - 2026-05-03

### Added

- Frontend WebSocket reconnect with exponential backoff (1s \u2192 30s max).
- Frontend health polling every 5s showing max agents, runner binary presence in sidebar.
- Backend `isHfCacheNoise()` filter suppresses HuggingFace cache verification progress bar from stderr broadcast.
- Backend 60s default timeout on OpenAI-compatible API runtime fetch calls.

### Changed

- Frontend `formatHarnessEvent` replaced with `useCallback`-memoized `formatEvent` to avoid re-renders.
- Frontend sidebar metrics now show `Max` (maxActiveAgents from health) and `Model` (runner binary present \u2713/\u2717).
- Frontend log rendering uses stable `formatEvent` reference in WebSocket effect dependency.

### Verified

- Full `verify:beta` gate passes: typecheck (0 errors), 14 tests (0 fail), lint (0 errors), build (268ms).
