#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  echo "All processes stopped."
}

trap cleanup EXIT INT TERM

# Which container runtime will the backend use? runtimeConfig has no npm
# dependencies, so this works before node_modules exists.
RUNTIME="$(node -e "console.log(require('$SCRIPT_DIR/ecoxai/backend/services/runtimeConfig').RUNTIME)" 2>/dev/null || echo docker)"
echo "Container runtime: $RUNTIME"

if [ "$RUNTIME" = "singularity" ]; then
  # HPC path: no daemon, no image build. The agent environment is provisioned
  # once into ordinary directories by build-agent-env.sh.
  AGENT_DIR="${ECOXAI_AGENT_DIR:-${ECOXAI_STATE_DIR:-$SCRIPT_DIR/ecoxai/backend/data/runtime}/agent}"
  if [ ! -f "$AGENT_DIR/ecoxai-agent.sif" ]; then
    echo "Agent environment not found. Building (one-time, several minutes)..."
    "$SCRIPT_DIR/ecoxai/backend/singularity/build-agent-env.sh"
  else
    echo "Agent environment found: $AGENT_DIR"
  fi
else
  # Build Docker image if not present
  if ! docker image inspect ecoxai-agent > /dev/null 2>&1; then
    echo "Docker image 'ecoxai-agent' not found. Building..."
    docker build \
      -f "$SCRIPT_DIR/ecoxai/backend/docker/Dockerfile.agent" \
      -t ecoxai-agent \
      "$SCRIPT_DIR/ecoxai/backend/docker/"
    echo "Docker image built."
  else
    echo "Docker image 'ecoxai-agent' found."
  fi
fi

# Install backend dependencies if needed
if [ ! -d "$SCRIPT_DIR/ecoxai/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd "$SCRIPT_DIR/ecoxai/backend" && npm install)
fi

# Start backend
echo "Starting backend..."
(cd "$SCRIPT_DIR/ecoxai/backend" && npm start) &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend..."
(cd "$SCRIPT_DIR/ecoxai/frontend" && python3 -m http.server 3000 2>/dev/null) &
FRONTEND_PID=$!

# Wait for backend to be ready (up to 20s)
echo "Waiting for backend..."
_tries=0
until curl -s --max-time 1 http://localhost:8081/api/pipeline/status > /dev/null 2>&1; do
  _tries=$((_tries + 1))
  if [ "$_tries" -ge 20 ]; then
    echo "Warning: backend did not respond after 20s — it may still be starting."
    break
  fi
  sleep 1
done

echo ""
echo "EcoXAI ready."
echo "  App:      http://localhost:8081"
echo "  Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl-C to stop."

wait "$BACKEND_PID" "$FRONTEND_PID"
