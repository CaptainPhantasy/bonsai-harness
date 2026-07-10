#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

export HOME="/Users/douglastalley"
export BUN_INSTALL="/Users/douglastalley/.bun"
export PATH="/Users/douglastalley/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export USER="${USER:-douglastalley}"
export LOGNAME="${LOGNAME:-douglastalley}"
export SHELL="${SHELL:-/bin/zsh}"
export TMPDIR="${TMPDIR:-/tmp}"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export __CF_USER_TEXT_ENCODING="${__CF_USER_TEXT_ENCODING:-0x1F5:0x0:0x0}"
export PORT="${PORT:-11431}"
export HARNESS_BIND_HOST="${HARNESS_BIND_HOST:-127.0.0.1}"
export HARNESS_MODEL_ID="${HARNESS_MODEL_ID:-gpt-4o-mini}"
export HARNESS_RUNTIME_KIND="${HARNESS_RUNTIME_KIND:-openai-compatible}"
export HARNESS_MAX_ACTIVE_AGENTS="${HARNESS_MAX_ACTIVE_AGENTS:-2}"
export HARNESS_SANDBOX_ROOT="${HARNESS_SANDBOX_ROOT:-$PROJECT_ROOT/sandbox}"
HARNESS_LOG_DIR="${HARNESS_LOG_DIR:-$PROJECT_ROOT/logs}"

mkdir -p "$HARNESS_LOG_DIR" "$HARNESS_SANDBOX_ROOT"
if ! ulimit -n 65536; then
  echo "[WARN] Could not raise file descriptor limit to 65536; continuing with $(ulimit -n)."
fi
exec >> "$HARNESS_LOG_DIR/harness.log" 2>> "$HARNESS_LOG_DIR/harness.error.log"
echo "[INFO] Model Harness launch $(date -u +%Y-%m-%dT%H:%M:%SZ) port=$PORT nofile=$(ulimit -n) sandbox=$HARNESS_SANDBOX_ROOT runtime=$HARNESS_RUNTIME_KIND model=$HARNESS_MODEL_ID"
cd "$PROJECT_ROOT/backend"
exec /Users/douglastalley/.bun/bin/bun run server.ts
