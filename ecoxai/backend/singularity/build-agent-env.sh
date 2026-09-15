#!/usr/bin/env bash
#
# Provision the EcoXAI agent environment for the Singularity runtime.
#
# Shared HPC clusters do not grant `singularity build --fakeroot` (it needs a
# /etc/subuid mapping that only an admin can add), so nothing can be installed
# *into* an image here. Instead this script pulls a stock image read-only and
# builds the Python and Node environments beside it, in ordinary directories
# that get bind-mounted at run time. Everything below runs as your own user.
#
# Result, under $AGENT_DIR:
#   ecoxai-agent.sif   read-only base image (python:3.11)
#   venv/              Python environment, mounted at /opt/venv
#   node/              Node.js 20 + Claude Code CLI, mounted at /opt/node
#
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${ECOXAI_STATE_DIR:-$BACKEND_DIR/data/runtime}"
AGENT_DIR="${ECOXAI_AGENT_DIR:-$STATE_DIR/agent}"
NODE_VERSION="${ECOXAI_NODE_VERSION:-v20.18.1}"
BASE_IMAGE="${ECOXAI_BASE_IMAGE:-docker://python:3.11}"

SIF="$AGENT_DIR/ecoxai-agent.sif"
VENV="$AGENT_DIR/venv"
NODE_DIR="$AGENT_DIR/node"

SINGULARITY="${ECOXAI_SINGULARITY_BIN:-$(command -v singularity || command -v apptainer || true)}"
if [ -z "$SINGULARITY" ]; then
  echo "ERROR: neither singularity nor apptainer found on PATH" >&2
  exit 1
fi

export SINGULARITY_CACHEDIR="${SINGULARITY_CACHEDIR:-$STATE_DIR/cache}"
mkdir -p "$AGENT_DIR" "$SINGULARITY_CACHEDIR"

echo "==> Agent directory: $AGENT_DIR"
echo "==> Using: $($SINGULARITY --version)"

# ---------------------------------------------------------------- base image
if [ -f "$SIF" ] && [ "${ECOXAI_FORCE_REBUILD:-0}" != "1" ]; then
  echo "==> Image already present: $SIF (set ECOXAI_FORCE_REBUILD=1 to replace)"
else
  echo "==> Pulling $BASE_IMAGE ..."
  "$SINGULARITY" pull --force "$SIF" "$BASE_IMAGE"
fi

# ------------------------------------------------------------------ python
# The venv is created at the SAME container path it will be mounted on at run
# time (/opt/venv). Creating it anywhere else would bake the wrong interpreter
# path into pyvenv.cfg and every console-script shebang.
if [ -x "$VENV/bin/python" ] && [ "${ECOXAI_FORCE_REBUILD:-0}" != "1" ]; then
  echo "==> Python environment already present: $VENV"
else
  echo "==> Creating Python environment at /opt/venv ..."
  mkdir -p "$VENV"
  "$SINGULARITY" exec --bind "$VENV:/opt/venv" "$SIF" python -m venv --clear /opt/venv
fi

echo "==> Installing Python packages (this takes a few minutes) ..."
"$SINGULARITY" exec --bind "$VENV:/opt/venv" "$SIF" /opt/venv/bin/pip install --no-cache-dir --upgrade pip
"$SINGULARITY" exec --bind "$VENV:/opt/venv" "$SIF" /opt/venv/bin/pip install --no-cache-dir \
  pandas \
  numpy \
  pyarrow \
  scikit-learn \
  matplotlib \
  seaborn \
  scipy \
  statsmodels \
  neo4j \
  requests \
  openai \
  python-dotenv \
  xgboost \
  lifelines \
  pymssql

# --------------------------------------------------------------------- node
# Node ships a relocatable linux-x64 tarball, and the Claude Code CLI is pure
# JavaScript, so both install on the host and run unchanged inside the image.
if [ -x "$NODE_DIR/bin/node" ] && [ "${ECOXAI_FORCE_REBUILD:-0}" != "1" ]; then
  echo "==> Node already present: $($NODE_DIR/bin/node --version)"
else
  echo "==> Installing Node $NODE_VERSION ..."
  mkdir -p "$NODE_DIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
    | tar -xJ -C "$NODE_DIR" --strip-components=1
fi

echo "==> Installing Claude Code CLI ..."
export PATH="$NODE_DIR/bin:$PATH"
npm install -g --prefix "$NODE_DIR" @anthropic-ai/claude-code

# ------------------------------------------------------------------- verify
echo
echo "==> Verifying inside the container ..."
"$SINGULARITY" exec \
  --cleanenv --contain --no-home \
  --bind "$VENV:/opt/venv" --bind "$NODE_DIR:/opt/node" \
  "$SIF" /bin/bash -lc '
    export PATH=/opt/venv/bin:/opt/node/bin:$PATH
    echo "  python : $(python --version 2>&1)"
    echo "  pandas : $(python -c "import pandas; print(pandas.__version__)")"
    echo "  sklearn: $(python -c "import sklearn; print(sklearn.__version__)")"
    echo "  node   : $(node --version)"
    echo "  claude : $(claude --version 2>&1 | head -1)"
  '

echo
echo "==> Done. Agent environment ready at $AGENT_DIR"
