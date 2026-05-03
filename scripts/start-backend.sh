#!/usr/bin/env bash
set -euo pipefail

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
export HARNESS_MODEL_ID="${HARNESS_MODEL_ID:-prism-ml/Ternary-Bonsai-8B-mlx-2bit}"
export HARNESS_RUNTIME_KIND="${HARNESS_RUNTIME_KIND:-local-command}"
export HARNESS_MAX_ACTIVE_AGENTS="${HARNESS_MAX_ACTIVE_AGENTS:-2}"
export HARNESS_RUNNER_BINARY="${HARNESS_RUNNER_BINARY:-/opt/homebrew/bin/mlx_lm}"
export HARNESS_RUNNER_ARGS_TEMPLATE="${HARNESS_RUNNER_ARGS_TEMPLATE:-generate --model {{modelId}} --prompt {{prompt}} --verbose False}"
export HARNESS_SANDBOX_ROOT="${HARNESS_SANDBOX_ROOT:-/Volumes/SanDisk1Tb/bonsai-harness/sandbox}"
export HARNESS_MODEL_CACHE_DIR="${HARNESS_MODEL_CACHE_DIR:-/Volumes/SanDisk1Tb/HFModels}"
export HARNESS_CACHE_DIR="${HARNESS_CACHE_DIR:-/Volumes/SanDisk1Tb/mlx-cache}"

mkdir -p /Volumes/SanDisk1Tb/bonsai-harness/logs "$HARNESS_SANDBOX_ROOT" "$HARNESS_MODEL_CACHE_DIR" "$HARNESS_CACHE_DIR"
if ! ulimit -n 65536; then
  echo "[WARN] Could not raise file descriptor limit to 65536; continuing with $(ulimit -n)."
fi
exec >> /Volumes/SanDisk1Tb/bonsai-harness/logs/harness.log 2>> /Volumes/SanDisk1Tb/bonsai-harness/logs/harness.error.log
echo "[INFO] Model Harness launch $(date -u +%Y-%m-%dT%H:%M:%SZ) port=$PORT nofile=$(ulimit -n) sandbox=$HARNESS_SANDBOX_ROOT runtime=$HARNESS_RUNTIME_KIND model=$HARNESS_MODEL_ID"
cd /Volumes/SanDisk1Tb/bonsai-harness/backend
exec /Users/douglastalley/.bun/bin/bun run server.ts
