#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Resetting lean backend..."

# # Check if backend is still running (port 8081, or LEAN_PORT if overridden)
# LEAN_PORT="${LEAN_PORT:-8081}"
# BACKEND_PID=$(netstat -ano 2>/dev/null | grep ":${LEAN_PORT} " | grep LISTENING | awk '{print $NF}' | head -1)
# if [ -n "$BACKEND_PID" ]; then
#   echo "ERROR: Backend is running (PID $BACKEND_PID on port ${LEAN_PORT}). Stop it first, then re-run reset.sh"
#   exit 1
# fi

echo '{"jobs":[],"datasets":{},"budget":{"totalCostUsd":0,"jobCount":0,"sessions":[]}}' \
  > "$SCRIPT_DIR/data/state.json"

# Remove SQLite DB and all WAL-mode companion files
rm -f "$SCRIPT_DIR/data/executions.db"
rm -f "$SCRIPT_DIR/data/executions.db-wal"
rm -f "$SCRIPT_DIR/data/executions.db-shm"
rm -rf "$SCRIPT_DIR/assets"
rm -rf "$SCRIPT_DIR/data/wikis"

# Clear agent storage. Docker keeps it in named volumes; Singularity keeps it in
# directories under the state dir. The provisioned agent environment (image,
# venv, node) is deliberately left alone — rebuilding it takes minutes.
RUNTIME="$(node -e "console.log(require('$SCRIPT_DIR/services/runtimeConfig').RUNTIME)" 2>/dev/null || echo docker)"
echo "Container runtime: $RUNTIME"

if [ "$RUNTIME" = "singularity" ]; then
  STATE_DIR="${ECOXAI_STATE_DIR:-$SCRIPT_DIR/data/runtime}"
  rm -rf "$STATE_DIR/workspaces" "$STATE_DIR/datasets" "$STATE_DIR/tmp"
  mkdir -p "$STATE_DIR/workspaces" "$STATE_DIR/datasets"
  echo "Cleared workspaces and datasets under $STATE_DIR"
else
  for vol in $(docker volume ls -q --filter name=ecoxai-workspace) ecoxai-datasets; do
    containers=$(docker ps -a -q --filter volume="$vol")
    [ -n "$containers" ] && docker rm -f $containers 2>/dev/null || true
  done

  docker volume rm $(docker volume ls -q --filter name=ecoxai-workspace) 2>/dev/null || true
  docker volume rm ecoxai-datasets 2>/dev/null || true
fi

echo "Done. Run 'node server.js' to start fresh."
