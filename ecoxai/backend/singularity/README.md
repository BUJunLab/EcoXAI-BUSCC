# Singularity runtime (HPC)

EcoXAI runs one agent per hypothesis in an isolated container. The original
design assumes Docker, which shared HPC clusters do not provide: the Docker
daemon runs as root, so access to it is effectively root on the node. This
directory holds the Singularity backend, which gets the same isolation without
a daemon and without any elevated privilege.

## What changes

| | Docker | Singularity |
|---|---|---|
| Container | object owned by a root daemon | a child process of the backend |
| Lifecycle | create → start → wait → remove | spawn → wait for exit |
| Storage | daemon-managed named volumes | ordinary directories, bind-mounted |
| Logs | multiplexed stream, demuxed by the client | the process's own stdout/stderr |
| Privilege | daemon access ≈ root | runs as you |

The backend picks a runtime automatically and both share the same code paths,
so nothing above the storage and execution layer knows which one is active.

## Selection

Resolved in `services/runtimeConfig.js`, first match wins:

1. `ECOXAI_RUNTIME=docker|singularity`
2. `EXECUTION_ENV=hpc` → singularity
3. a reachable Docker socket → docker
4. `singularity` or `apptainer` on `PATH` → singularity
5. docker

## One-time setup

```bash
# Node 20+ must be on PATH; the cluster module (nodejs/8.2.1) is too old.
export PATH=/path/to/node20/bin:$PATH

cd ecoxai/backend
npm install                      # needs a C++20 compiler for better-sqlite3:
                                 #   source /opt/rh/gcc-toolset-13/enable
./singularity/build-agent-env.sh # ~10 min, ~2.2 GB
```

`build-agent-env.sh` provisions, under `$ECOXAI_STATE_DIR/agent`:

- `ecoxai-agent.sif` — stock `python:3.11`, pulled read-only
- `venv/` — the Python stack, mounted at `/opt/venv`
- `node/` — Node 20 + Claude Code CLI, mounted at `/opt/node`

Nothing is installed *into* the image, because `singularity build --fakeroot`
needs an `/etc/subuid` mapping only an admin can grant. Pulling an image and
building the environments beside it needs no privilege at all.

## Environment variables

| Variable | Purpose |
|---|---|
| `ECOXAI_RUNTIME` | force `docker` or `singularity` |
| `ECOXAI_STATE_DIR` | root for workspaces, datasets, agent env (default `backend/data/runtime`) |
| `ECOXAI_AGENT_DIR` | agent env location, if separate from the state dir |
| `ECOXAI_AGENT_SIF` | path to an alternative image |
| `ECOXAI_EXTRA_BINDS` | colon-separated `host:container[:ro]` mounts for agents |
| `ECOXAI_FORCE_REBUILD=1` | rebuild the agent environment from scratch |

Put large state on shared project storage, not a quota-limited home:

```bash
export ECOXAI_STATE_DIR=/projectnb/<project>/$USER/ecoxai
```

Check what `/scratch` actually is on your cluster before using it. On BU SCC it
is a node-local disk (`/dev/sda8`) that is purged periodically, so state written
there is invisible from every other node — including the compute node a job
lands on. The agent environment alone is ~2.2 GB and workspaces accumulate per
job, so it needs to live somewhere shared and persistent.

## Isolation

Agents run with `--cleanenv --contain --no-home`. They see only `/workspace`
(read-write), `/datasets` (read-only), `/opt/venv`, `/opt/node` and
`/opt/ecoxai-bin`. The host home directory is not mounted and host environment
variables are not inherited.

**Job environment is passed through a NUL-delimited file, never through
`SINGULARITYENV_*`.** Singularity injects those host variables by generating a
shell script that the container sources, so any value reaching them is evaluated
by a shell first — `$1` becomes a positional parameter, `$HOME` leaks the host
path, and backticks execute *on the host*. Agent prompts carry LLM-generated
hypothesis text and user-supplied research questions, which makes that a host
command injection vector. `agent-run.sh` instead reads `/workspace/.ecoxai-env`
with `export "$entry"`, which assigns literally and never re-expands, then
deletes the file.

## Known gaps versus the Docker image

- **No `msodbcsql18` / Kerberos.** Installing the Microsoft ODBC driver needs
  root. `pymssql` is installed as a pure-Python alternative for SQL Server; the
  `kinit` path in `agent-run.sh` is skipped when the binary is absent.
- **No memory or CPU limits.** cgroup limits need root or delegated cgroup v2.
  Use the cluster scheduler to bound resources instead.
- **Agent `pip install` writes to `/workspace/.pylibs`,** not the shared venv,
  which is mounted read-only so concurrent jobs cannot corrupt it. `PIP_TARGET`
  and `PYTHONPATH` are preset, so plain `pip install X` works and stays scoped
  to the job.
