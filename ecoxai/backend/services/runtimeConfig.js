'use strict';

/**
 * Runtime configuration — selects the container backend and resolves every
 * path the backend needs on disk.
 *
 * EcoXAI originally assumed Docker: a daemon that owns named volumes and
 * long-lived container objects. On a shared HPC cluster there is no Docker
 * daemon (it would hand every user root), so the Singularity backend runs each
 * agent as a plain child process and keeps workspaces in ordinary directories.
 *
 * Selection order:
 *   1. ECOXAI_RUNTIME=docker|singularity   (explicit wins)
 *   2. EXECUTION_ENV=hpc                   → singularity
 *   3. a reachable Docker socket           → docker
 *   4. singularity/apptainer on PATH       → singularity
 *   5. docker (historical default)
 */

const fs = require('fs');
const path = require('path');

function onPath(binary) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return path.join(dir, binary);
    } catch { /* keep looking */ }
  }
  return null;
}

function detectRuntime() {
  const explicit = (process.env.ECOXAI_RUNTIME || '').trim().toLowerCase();
  if (explicit === 'docker' || explicit === 'singularity') return explicit;

  if ((process.env.EXECUTION_ENV || '').trim().toLowerCase() === 'hpc') return 'singularity';

  if (process.env.DOCKER_HOST) return 'docker';
  try {
    fs.accessSync('/var/run/docker.sock');
    return 'docker';
  } catch { /* no docker socket */ }

  if (onPath('singularity') || onPath('apptainer')) return 'singularity';

  return 'docker';
}

const RUNTIME = detectRuntime();
const IS_SINGULARITY = RUNTIME === 'singularity';

/**
 * Where mutable runtime state lives. Defaults inside the backend directory so a
 * plain checkout works; on HPC point ECOXAI_STATE_DIR at fast scratch instead of
 * a quota-limited home directory.
 */
const STATE_DIR = path.resolve(
  process.env.ECOXAI_STATE_DIR || path.join(__dirname, '..', 'data', 'runtime')
);

const WORKSPACES_DIR = path.join(STATE_DIR, 'workspaces');
const DATASETS_DIR = path.join(STATE_DIR, 'datasets');

// Threads each agent may use. Singularity gets no cgroup limits, so NumPy,
// XGBoost and friends otherwise size their pools from the node's total core
// count and blow past the slots the batch scheduler granted — which gets the
// whole job killed, backend included. ECOXAI_AGENT_THREADS is the explicit
// setting; NSLOTS is the SGE fallback. Unset means "don't clamp" (a laptop).
const AGENT_THREADS = (() => {
  const raw = process.env.ECOXAI_AGENT_THREADS || process.env.NSLOTS;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
})();
const AGENT_DIR = path.resolve(process.env.ECOXAI_AGENT_DIR || path.join(STATE_DIR, 'agent'));

/** The read-only base image, the Python environment, and the Node/Claude Code tree. */
const SIF_PATH = process.env.ECOXAI_AGENT_SIF || path.join(AGENT_DIR, 'ecoxai-agent.sif');
const VENV_DIR = process.env.ECOXAI_AGENT_VENV || path.join(AGENT_DIR, 'venv');
const NODE_DIR = process.env.ECOXAI_AGENT_NODE || path.join(AGENT_DIR, 'node');

const SINGULARITY_BIN = process.env.ECOXAI_SINGULARITY_BIN
  || onPath('singularity') || onPath('apptainer') || 'singularity';

/** Extra host paths to expose read-only inside agent containers (colon-separated). */
const EXTRA_BINDS = (process.env.ECOXAI_EXTRA_BINDS || '')
  .split(path.delimiter).map(s => s.trim()).filter(Boolean);

function workspaceDir(jobId) {
  return path.join(WORKSPACES_DIR, String(jobId));
}

/**
 * Rewrite loopback URLs so an agent can reach backend services on the host.
 *
 * Docker puts the container on its own network namespace, so localhost has to
 * become host.docker.internal. Singularity shares the host network, so the URL
 * is already correct and must be left alone.
 */
function containerReachableUrl(url) {
  if (!url) return url;
  if (IS_SINGULARITY) return url;
  return url
    .replace(/localhost/g, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

/** Hostname an agent should use to call this backend. */
function backendHost() {
  return IS_SINGULARITY ? '127.0.0.1' : 'host.docker.internal';
}

function ensureDirs() {
  for (const dir of [STATE_DIR, WORKSPACES_DIR, DATASETS_DIR, AGENT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function describe() {
  return IS_SINGULARITY
    ? `runtime=singularity state=${STATE_DIR} sif=${SIF_PATH}`
    : 'runtime=docker';
}

module.exports = {
  RUNTIME,
  IS_SINGULARITY,
  STATE_DIR,
  WORKSPACES_DIR,
  DATASETS_DIR,
  AGENT_THREADS,
  AGENT_DIR,
  SIF_PATH,
  VENV_DIR,
  NODE_DIR,
  SINGULARITY_BIN,
  EXTRA_BINDS,
  workspaceDir,
  containerReachableUrl,
  backendHost,
  ensureDirs,
  describe,
};
