#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Resetting lean backend..."

# Refuse to wipe state out from under a running backend. The old check shelled
# out to `netstat -ano | grep LISTENING`, which is Windows syntax and matched
# nothing here, so it was commented out. The backend now writes a lock file next
# to the state it owns, which also catches a backend running on another node.
LOCK="$SCRIPT_DIR/data/.backend.lock"
if [ -f "$LOCK" ]; then
  echo "ERROR: a backend still holds this state directory:"
  sed 's/^/  /' "$LOCK"
  echo "Stop it first, then re-run reset.sh."
  exit 1
fi

# Every result the pipeline produces — per-job reports, figures, scripts,
# verdicts — lives in assets/ and data/wikis/. Workspaces are deleted the
# moment a job finishes, so these directories are the only copy. A reset used
# to delete them outright, and one run's figures were lost that way. Move them
# aside first; pass --no-archive to discard.
ARCHIVE_ROOT="${ECOXAI_ARCHIVE_DIR:-${ECOXAI_STATE_DIR:-$SCRIPT_DIR/data/runtime}/archive}"
if [ "${1:-}" != "--no-archive" ]; then
  have=""
  for d in assets data/wikis; do
    [ -d "$SCRIPT_DIR/$d" ] && [ -n "$(ls -A "$SCRIPT_DIR/$d" 2>/dev/null)" ] && have=1
  done
  if [ -n "$have" ]; then
    ARCHIVE="$ARCHIVE_ROOT/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$ARCHIVE"
    [ -d "$SCRIPT_DIR/assets" ] && mv "$SCRIPT_DIR/assets" "$ARCHIVE/assets"
    [ -d "$SCRIPT_DIR/data/wikis" ] && mv "$SCRIPT_DIR/data/wikis" "$ARCHIVE/wikis"
    cp "$SCRIPT_DIR/data/state.json" "$ARCHIVE/" 2>/dev/null || true
    for f in executions.db executions.db-wal executions.db-shm; do
      [ -f "$SCRIPT_DIR/data/$f" ] && cp "$SCRIPT_DIR/data/$f" "$ARCHIVE/"
    done
    echo "Archived previous results to $ARCHIVE"
  fi
fi

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
