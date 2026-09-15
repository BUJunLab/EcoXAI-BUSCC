#!/usr/bin/env bash
#
# In-container entrypoint for the Singularity runtime — the counterpart to
# docker/entrypoint.sh. Bind mounts supplied by singularityManager:
#
#   /workspace   read-write job workspace (also HOME)
#   /datasets    read-only normalized datasets
#   /opt/venv    Python environment
#   /opt/node    Node.js + Claude Code CLI
#
set -uo pipefail

# Load the job environment from the NUL-delimited file the backend wrote.
#
# It is NOT passed through SINGULARITYENV_*: Singularity injects those by
# generating a shell script the container sources, which evaluates the value —
# so a prompt containing `$HOME` or backticks would expand, or execute, on the
# host. `export "$entry"` below assigns literally and never re-expands, so task
# text may contain any character.
ENV_FILE=/workspace/.ecoxai-env
if [ -f "$ENV_FILE" ]; then
    while IFS= read -r -d '' entry; do
        [ -n "$entry" ] && export "$entry"
    done < "$ENV_FILE"
    rm -f "$ENV_FILE"
fi

export PATH="/opt/venv/bin:/opt/node/bin:$PATH"
export HOME=/workspace

# The venv is mounted read-only and shared across concurrent jobs, so send any
# package the agent installs to a per-job directory instead, and put that
# directory ahead of the venv on the import path.
export PIP_TARGET=/workspace/.pylibs
export PYTHONPATH="/workspace/.pylibs${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1
export MPLBACKEND=Agg

mkdir -p /workspace/output /workspace/.claude /workspace/.pylibs

TASK="${TASK:-$(cat /workspace/task.txt 2>/dev/null || echo 'No task provided')}"

if [ -n "${KRB5_USER:-}" ] && [ -n "${KRB5_PASSWORD:-}" ]; then
    if command -v kinit >/dev/null 2>&1; then
        echo "=== Obtaining Kerberos ticket for ${KRB5_USER}@CSMC.EDU ==="
        echo "${KRB5_PASSWORD}" | kinit -l 8h "${KRB5_USER}@CSMC.EDU" 2>&1 \
            && echo "Kerberos ticket obtained successfully" \
            || echo "WARNING: kinit failed — CS_Analyze connection may not work"
    else
        echo "WARNING: KRB5_USER set but kinit is not available in this image"
    fi
fi

cd /workspace

echo "=== ECOXAI AGENT STARTING (singularity) ==="
echo "Task: $TASK"
echo "=== EXECUTING ==="
echo ""

# Claude Code refuses to run non-interactively without a settings file present.
if [ ! -f /workspace/.claude/settings.json ]; then
    printf '{"hasCompletedOnboarding":true,"skipDangerousModePermissionPrompt":true}' \
        > /workspace/.claude/settings.json
fi

MODEL_FLAG=()
if [ -n "${CLAUDE_MODEL:-}" ]; then
    MODEL_FLAG=(--model "${CLAUDE_MODEL}")
fi

# The prompt must precede --allowedTools or the CLI does not recognize it.
claude "${MODEL_FLAG[@]}" --print --output-format stream-json --verbose \
    --dangerously-skip-permissions "$TASK" \
    --allowedTools "Bash(python*),Bash(pip*),Read,Write,Edit,Glob,Grep"
EXIT_CODE=$?

echo ""
echo "=== AGENT COMPLETED ==="
echo "Exit code: $EXIT_CODE"

if [ -d "/workspace/output" ] && [ -n "$(ls -A /workspace/output 2>/dev/null)" ]; then
    echo "Generated files:"
    ls -la /workspace/output/
fi

exit $EXIT_CODE
