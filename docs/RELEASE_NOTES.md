# Release Notes
## Or: A Human-Readable Account of What Changed, What Got Fixed, and What We're Quietly Proud Of

---

DOCUMENT CLASSIFICATION: RELEASE NARRATIVE / HUMAN-FACING / READ THIS BEFORE THE CHANGELOG
COMPANION DOC: `CHANGELOG.md` is the machine-readable, conventional-commits-shaped record. This file is the version your future self will actually want to read at 2:47 AM trying to remember what beta.3 changed.

---

## `Unreleased` — *The Provider and MCP Refactor* (2026-07-10)

The harness now executes only OpenAI-compatible Chat Completions and native Anthropic Messages requests. The legacy local-command/MLX path is removed from active configuration and launch paths. Provider keys remain on the backend.

Browser-originated OpenCode Zen requests now travel through the same-origin `POST /gateway` relay. That relay accepts only the exact `https://opencode.ai/zen/v1` path boundary, `GET`/`POST` envelopes, and an allowlisted header set, so the browser never directly fetches a gateway that lacks the necessary CORS headers.

MCP is now a real stdio lifecycle rather than a static registry: a connected installed server is initialized, its tools are discovered, and its tools are presented to providers. Tool calls default to owner-bound explicit approval; tool results and tool-call rounds are bounded. The current operator contract and the complete verification command are in `README.md` and `CHEATSHEET.md`.

---

## `0.1.0-beta.3` — *The Reconnect Update* (2026-05-03)

### Headline

The dashboard now survives network blips. The model now answers `2+2=` correctly in 2.1 seconds. The HuggingFace cache stops shouting in the event log. Beta is closer to feeling like a real tool and less like a demo we wired together at 2 AM (it was, in fact, wired together at 2 AM, but we've cleaned it up).

### What's actually new

**Frontend got polite.** The WebSocket connection now reconnects with exponential backoff — 1 second on the first retry, doubling up to a 30-second ceiling. If you walk away from the dashboard, your network cycles, and you come back, the dashboard catches up instead of just sulking with a *Disconnected* badge.

**Health polling, finally.** Every 5 seconds the sidebar refreshes from `/health` and shows you two things you actually care about: how many active agents you have versus your cap (`Max`), and whether the runner binary is present on disk (`Model: ✓` or `✗`). If `Model` is `✗`, no spawn will ever succeed — knowing this in the UI saves you from staring at a dead WebSocket wondering why nothing happens.

**Stderr got quieter.** HuggingFace's progress bars are emitted on stderr, which is fine for a CLI but hostile in a streaming UI. The backend now filters `isHfCacheNoise()` before broadcasting. Real errors still come through. Cache-warming theatrics do not.

**API timeouts are bounded.** OpenAI-compatible runtime calls now time out at 60 seconds instead of "however long the upstream feels like." If a remote model gets stuck, your dashboard will too — but only for a bounded amount of time, after which the agent exits cleanly.

**Frontend is less re-render-happy.** `formatHarnessEvent` was inlined and rebuilt on every render, which was making the log view stutter once you crossed a few hundred events. Replaced with a `useCallback`-memoized `formatEvent`. Smooth scrolling restored.

### Verified

- `verify:beta` exits 0 across the board: typecheck (0 errors), 14 tests passing, lint (0), build (~268ms)
- Real Bonsai run confirmed: `prism-ml/Ternary-Bonsai-8B-mlx-2bit` answered `2+2=` → `2 + 2 = 4` in ~2.1s, transcribed off the live WebSocket
- `/health` reports `runnerBinaryPresent: true` for `/opt/homebrew/bin/mlx_lm`
- Model cache lives at `HFModels/hub/models--prism-ml--Ternary-Bonsai-8B-mlx-2bit/`

### Known gaps (still)

- No auth layer. Single-operator local tool. Bind to `127.0.0.1`. Don't expose it.
- No durable process registry. Backend restart drops in-flight agents. This is on purpose for beta.
- No production target. We're not pretending otherwise.
- No browser E2E test suite. Manual smoke is the gate for now.

---

## `0.1.0-beta.2` — *The Naming Cleanup* (2026-05-03, earlier)

### Headline

We stopped calling everything `BONSAI_*` and admitted the truth: this is a generic harness that *defaults* to Bonsai. The model is the default, not the identity. Renamed the env vars to `HARNESS_*` accordingly. Old configs need to update.

### What changed

- **Env var rename:** `BONSAI_*` → `HARNESS_*`. Update your `.env`, your shell exports, your launchd plist. Every reference. There's no compatibility shim. You get one find-and-replace and a fresh start.
- **Smoke timeout: 5s → 60s.** The original 5-second cap worked fine for `/bin/echo` smoke tests but fell over the moment a real MLX model needed a few seconds to load weights from disk. 60 seconds is generous enough for cold-start and tight enough that hung calls don't sit forever.
- **`bonsai:e2e` script added.** Spawns the backend, fires a real Bonsai inference, captures the WebSocket transcript, exits with the result. Use it whenever you change anything that touches the spawn or stream paths.
- **Smoke uses `smoke/slm`.** The smoke test no longer pretends to load a real model ID. It uses an obviously-fake identifier so nothing in the system thinks it should look up weights.

### Why

Honesty in naming. If we ever swap Bonsai for a different default model, we don't want to be stuck either renaming a hundred env vars or living a lie where `BONSAI_API_KEY` is talking to OpenAI. The harness is generic. The current default is Bonsai. Both true.

---

## `0.1.0-beta.1` — *The Beta Cutover* (2026-05-03, earliest)

### Headline

This is the moment Bonsai Harness became a real tool that produces evidence on demand instead of a notebook full of one-off scripts. We claimed our ports, wrote our docs, defined our gates, and — critically — got off port `3000` forever.

### What's actually new

**Port governance.** Backend is now on `11431`, frontend on `11432`. Both are claimed in the local SSOT port registry at `/Volumes/SanDisk1Tb/SSOT/port-registry.json`. The forbidden port `3000` does not appear as a default anywhere in the source tree. You can grep for it. We did. It's gone.

**Docs.** A real README. A real FEATURES doc. A real CHANGELOG. A real OpenAPI 3.1 contract. A real CI workflow. A real Dockerfile. A real LaunchAgent template. None of these are "to be written later." They exist now and they are accurate now.

**Health is honest.** `/health` reports the resolved port and sandbox root, not just hardcoded constants. If you override either via env vars, the response reflects it.

**Frontend is configurable.** `VITE_HARNESS_BACKEND_URL` (was `VITE_BONSAI_BACKEND_URL`, see beta.2) drives both HTTP and WebSocket URL derivation. No more hardcoded `ws://localhost:3000` lurking in source.

**Sandbox can move.** `HARNESS_SANDBOX_ROOT` is overridable so containers and launchd installations can write to the right place.

**LaunchAgent is real.** Plist sets the claimed port, points stdio at safe `/tmp` paths (avoiding the macOS xpcproxy denial that bites you when you try to write directly to an external volume from a launchd context), redirects runtime logs into `logs/`, and raises the file descriptor soft limit to 65536.

### Fixed

- `buildSpawnArguments` test was asserting an incorrect MLX CLI shape. Updated to match the actual `eval --model <model> --prompt <prompt>` contract.
- Frontend used to throw on malformed backend WebSocket JSON. It now logs an operator-visible error and keeps going.

### Known beta gaps (declared up front)

- No authn / authz.
- No durable process registry across backend restarts.
- No production deployment target.
- No browser E2E suite.
- The active directory was not yet a Git repo at cutover time — release evidence is file-based for beta.1. (As of beta.2/beta.3 it's a real repo.)

---

## How We Ship

Ship → Verify → Document → Repeat.

Every release goes through `verify:beta` before the version number gets touched. If the gate fails, the version doesn't change. The CHANGELOG entry doesn't get written. The release notes don't get drafted. There is no "we'll fix it in the next one."

Math. Not vibes.

---

## Closing

> "We've been told this is a small project. We agree. That's the point. Bonsai is a small tree, by design and by name. Bonsai Harness is a small orchestrator, by design and by name. The thing other labs are calling 'AI infrastructure' is a redwood that requires three site reliability engineers and a quarterly OKR review just to deploy. We don't need a redwood. We need a bonsai. The cats agree."
> — Floyd, 2026-05-03

---

DOCUMENT FOOTER:
- See `CHANGELOG.md` for the structured per-release diff
- See `BETA_RELEASE_STANDARD.md` for the gates each release must clear
- Maintainer: Douglas Talley
- AI counterpart: Floyd (he wrote half the diffs and let Douglas take credit because that's the kind of relationship they have)
- Senior PM (feline): Bella, who has not vetoed any release so far, which is the highest praise available in this organization
