'use strict';

/**
 * Singularity runtime backend.
 *
 * Drop-in replacement for containerManager on clusters with no Docker daemon.
 * The contract is identical; the mechanics are simpler. Docker asks a
 * root-owned daemon to create a container object, then attaches to a multiplexed
 * log stream and polls for exit. Singularity has no daemon: the container is a
 * child process, its stdout is our stdout, and its exit code is the process exit
 * code. Storage is ordinary directories bind-mounted into the container rather
 * than daemon-managed named volumes.
 *
 * Isolation comes from --contain --no-home --cleanenv: the agent sees only the
 * paths bound below, never the user's home directory or host environment.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const { randomUUID: uuidv4 } = require('crypto');

const dbManager = require('./databaseManager');
const { formatClaudeOutput, ExecutionLogBuffer } = require('./agentRunShared');
const rc = require('./runtimeConfig');

const RUN_CONFIG = {
  TIMEOUT_MS: 48 * 60 * 60 * 1000, // 48 hours
};

const BIN_DIR = path.join(__dirname, '..', 'singularity');
/** Written into the workspace, consumed and deleted by agent-run.sh. */
const ENV_FILE_NAME = '.ecoxai-env';
const MAX_TEXT_BYTES = 50 * 1024 * 1024; // guard against the V8 string length limit

/** Files worth surfacing from the workspace root (output/ is collected wholesale). */
const ROOT_ARTIFACT_EXTS = new Set([
  '.json', '.csv', '.feather', '.txt', '.png', '.jpg', '.md', '.html', '.py',
]);
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf']);
/** Large data formats: recorded as a path reference, never loaded into Node memory. */
const DATA_EXTS = new Set(['.feather', '.parquet', '.h5', '.hdf5', '.pkl', '.npy', '.npz']);

async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

class SingularityManager {
  constructor() {
    this.activeRuns = new Map();     // jobId -> { child, startTime, runId }
    this.timeoutHandles = new Map();
    rc.ensureDirs();
  }

  _jobTmpDir(jobId) {
    return path.join(rc.STATE_DIR, 'tmp', String(jobId));
  }

  /**
   * Hand the agent its environment through a NUL-delimited file rather than
   * through SINGULARITYENV_* host variables.
   *
   * Singularity injects those host variables by generating a shell script that
   * the container sources, so any value reaching them is evaluated by a shell
   * first: `$1` becomes a positional parameter, `$HOME` leaks the host path, and
   * backticks execute on the host. Agent prompts carry LLM-generated hypothesis
   * text and user-supplied research questions, so that path is a host command
   * injection vector, not merely a quoting nuisance.
   *
   * A NUL-delimited file is read back by agent-run.sh with `export "$line"`,
   * which assigns literally and never re-expands — so values may contain
   * newlines, quotes, dollar signs and backticks safely.
   */
  async _writeEnvFile(jobId, vars) {
    const target = path.join(rc.workspaceDir(jobId), ENV_FILE_NAME);
    const chunks = [];
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined || value === null) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.warn(`[${jobId}] Skipping env var with unsafe name: ${key}`);
        continue;
      }
      chunks.push(`${key}=${String(value)}\0`);
    }
    await fsp.writeFile(target, chunks.join(''), { mode: 0o600 });
    return target;
  }

  /** Environment for the singularity process itself — carries no job data. */
  _spawnEnv() {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const key of ['SINGULARITY_CACHEDIR', 'APPTAINER_CACHEDIR', 'SINGULARITY_TMPDIR', 'LANG', 'LC_ALL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return env;
  }

  async runJob(job, state, onOutput, onComplete, onError, onHypothesesExtracted, broadcast) {
    const { id, prompt, datasetId, selectedSkills } = job;
    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    let logBuffer = null;

    try {
      try {
        await dbManager.createRun({
          run_id: runId, job_id: id, prompt, dataset_id: datasetId || null,
          selected_skills: selectedSkills ? selectedSkills.join(',') : null,
          started_at: startedAt,
        });
        logBuffer = new ExecutionLogBuffer(runId);
      } catch (dbError) {
        console.warn(`[${id}] Skipping observability (no DB):`, dbError.message);
      }

      const volumeManager = require('./volumeManager');
      const { prepareWorkspace } = require('./workspacePrep');
      const { enhancedPrompt } = await prepareWorkspace(id, job, state, volumeManager);

      const backendPort = process.env.PORT || 8081;
      const vars = {
        TASK: enhancedPrompt,
        JOB_ID: id,
        RUN_ID: runId,
        DATASET_ID: datasetId || '',
        BACKEND_URL: `http://${rc.backendHost()}:${backendPort}`,
      };

      if (datasetId && state?.datasets?.[datasetId]) {
        const dataset = state.datasets[datasetId];
        vars.DATASET_FILENAME = dataset.filename || '';
        vars.DATASET_RECORDS = dataset.recordCount || 0;
        if (dataset.normalization) {
          vars.DATASET_NORMALIZED = '1';
          vars.DATASET_CONFIDENCE = dataset.normalization.confidence || 0;
          vars.DATASET_DOMAIN = dataset.normalization.semanticMetadata?.domain || 'unknown';
          vars.DATASET_DOCUMENT_TYPE = dataset.normalization.documentType || 'unknown';
          if (dataset.normalization.semanticMetadata) {
            vars.DATASET_SEMANTIC_JSON = JSON.stringify(dataset.normalization.semanticMetadata);
          }
        } else {
          vars.DATASET_NORMALIZED = '0';
        }
      }

      if (selectedSkills && selectedSkills.length > 0) vars.SELECTED_SKILLS = selectedSkills.join(',');
      if (job._hypothesisId) vars.HYPOTHESIS_ID = job._hypothesisId;

      // Local LLM takes explicit priority over Foundry, matching the Docker backend:
      // CLAUDE_CODE_USE_FOUNDRY may be set by an outer Claude Code session and must
      // not bleed into agent runs when the user intends local-LLM mode.
      if (process.env.ANTHROPIC_BASE_URL) {
        vars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        vars.ANTHROPIC_BASE_URL = rc.containerReachableUrl(process.env.ANTHROPIC_BASE_URL);
      } else if (process.env.CLAUDE_CODE_USE_FOUNDRY === '1') {
        vars.CLAUDE_CODE_USE_FOUNDRY = '1';
        vars.ANTHROPIC_FOUNDRY_RESOURCE = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
        vars.ANTHROPIC_FOUNDRY_API_KEY = process.env.ANTHROPIC_FOUNDRY_API_KEY;
        if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
          vars.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        }
      } else {
        vars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
          vars.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        }
      }
      if (process.env.CLAUDE_MODEL) vars.CLAUDE_MODEL = process.env.CLAUDE_MODEL;
      if (process.env.KRB5_USER) vars.KRB5_USER = process.env.KRB5_USER;
      if (process.env.KRB5_PASSWORD) vars.KRB5_PASSWORD = process.env.KRB5_PASSWORD;

      const workspaceDir = rc.workspaceDir(id);
      const tmpDir = this._jobTmpDir(id);
      await fsp.mkdir(tmpDir, { recursive: true });
      await fsp.mkdir(workspaceDir, { recursive: true });

      if (!fs.existsSync(rc.SIF_PATH)) {
        throw new Error(
          `Agent image not found at ${rc.SIF_PATH}. Run singularity/build-agent-env.sh first.`
        );
      }

      const binds = [
        `${workspaceDir}:/workspace`,
        `${rc.DATASETS_DIR}:/datasets:ro`,
        `${rc.VENV_DIR}:/opt/venv:ro`,
        `${rc.NODE_DIR}:/opt/node:ro`,
        `${BIN_DIR}:/opt/ecoxai-bin:ro`,
        ...rc.EXTRA_BINDS,
      ];

      const args = ['exec', '--cleanenv', '--contain', '--no-home', '--workdir', tmpDir, '--pwd', '/workspace'];
      for (const bind of binds) args.push('--bind', bind);
      args.push(rc.SIF_PATH, '/bin/bash', '/opt/ecoxai-bin/agent-run.sh');

      await this._writeEnvFile(id, vars);

      const child = spawn(rc.SINGULARITY_BIN, args, {
        env: this._spawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeRuns.set(id, { child, startTime: Date.now(), runId });
      onOutput(`[Singularity run ${runId.substring(0, 12)} started — pid ${child.pid}]\n`);

      const timeoutId = setTimeout(async () => {
        console.log(`Job ${id} timed out`);
        await this.stopJob(id);
        onError(new Error('Container timeout exceeded'));
      }, RUN_CONFIG.TIMEOUT_MS);
      this.timeoutHandles.set(id, timeoutId);

      let buffer = '';
      const skillsInvoked = new Set();

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        const timestamp = new Date().toISOString();
        buffer += text;
        const lines = buffer.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const skillMatch = line.match(/SKILL_INVOKED:\s*(\S+)/);
          if (skillMatch) skillsInvoked.add(skillMatch[1]);
          try {
            const json = JSON.parse(line);
            const { displayText, logData } = formatClaudeOutput(json);
            if (displayText) onOutput(displayText + '\n');
            if (logData && logBuffer) {
              try {
                switch (logData.type) {
                  case 'init': logBuffer.addInitData(logData); break;
                  case 'assistant_message': logBuffer.addAssistantMessage(logData, timestamp); break;
                  case 'tool_results': logBuffer.addToolResults(logData.results, timestamp); break;
                  case 'completion': logBuffer.addCompletion(logData); break;
                  case 'error': logBuffer.addError(logData.error_message, logData.total_cost_usd); break;
                }
              } catch (logError) {
                console.warn(`[${id}] Log error:`, logError.message);
              }
            }
          } catch {
            onOutput(line + '\n');
          }
        }
        buffer = lines[lines.length - 1];
      });

      child.stderr.on('data', (chunk) => { onOutput(`[stderr] ${chunk.toString('utf-8')}`); });

      const exitCode = await new Promise((resolve) => {
        child.on('error', (err) => {
          onOutput(`[spawn error] ${err.message}\n`);
          resolve(-1);
        });
        child.on('close', (code, signal) => resolve(code === null ? (signal ? 137 : -1) : code));
      });

      const tid = this.timeoutHandles.get(id);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(id); }

      const artifacts = await this._getArtifacts(id, job._stageId);

      if (logBuffer) {
        try {
          await logBuffer.flush();
          const completedAt = new Date().toISOString();
          const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
          await dbManager.updateRun(runId, {
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: exitCode,
            status: exitCode === 0 ? 'completed' : 'failed',
            total_cost_usd: logBuffer.completionData?.total_cost_usd || null,
            num_turns: logBuffer.completionData?.num_turns || logBuffer.currentTurn,
            artifacts_json: JSON.stringify(artifacts.map(({ buffer: _b, ...a }) => a)),
            skills_invoked: Array.from(skillsInvoked).join(',') || null,
            error_message: logBuffer.errorMessage || null,
          });

          const { processJobCompletion } = require('./jobPostCompletion');
          await processJobCompletion({
            jobId: id, runId, job, artifacts, exitCode,
            storageService: volumeManager, state, onHypothesesExtracted, broadcast,
          });
        } catch (dbError) {
          console.warn(`[${id}] Failed to update run record:`, dbError.message);
        }
      }

      const runStartedMs = this.activeRuns.get(id)?.startTime ?? Date.now();
      this.activeRuns.delete(id);
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      // agent-run.sh deletes this on startup; remove it again in case it never ran.
      await fsp.rm(path.join(rc.workspaceDir(id), ENV_FILE_NAME), { force: true }).catch(() => {});

      onComplete({
        exitCode,
        artifacts,
        skillsInvoked: Array.from(skillsInvoked),
        duration: Date.now() - runStartedMs,
        totalCostUsd: logBuffer?.completionData?.total_cost_usd ?? null,
        numTurns: logBuffer?.completionData?.num_turns ?? logBuffer?.currentTurn ?? null,
      });

    } catch (error) {
      if (logBuffer) {
        try {
          await dbManager.updateRun(runId, {
            completed_at: new Date().toISOString(), status: 'failed',
            exit_code: -1, error_message: error.message,
          });
        } catch { /* best effort */ }
      }
      this.activeRuns.delete(id);
      const tid = this.timeoutHandles.get(id);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(id); }
      onError(error);
    }
  }

  /**
   * Collect artifacts by reading the workspace directory directly. The Docker
   * backend needs a throwaway container for this because the bytes live inside a
   * daemon-managed volume; here the same files are already on the filesystem.
   */
  async _getArtifacts(jobId, stageId) {
    const artifacts = [];
    const root = rc.workspaceDir(jobId);

    try {
      const ALWAYS_EXCLUDE = new Set(['CLAUDE.md']);
      const EXCLUDE_EXCEPT_EXPLORE = new Set(['exploration_report.md']);

      const outputFiles = await walkFiles(path.join(root, 'output'));

      const rootFiles = [];
      for (const entry of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        if (ROOT_ARTIFACT_EXTS.has(path.extname(entry.name).toLowerCase())) {
          rootFiles.push(path.join(root, entry.name));
        }
      }

      const filePaths = [...outputFiles, ...rootFiles].filter((full) => {
        const filename = path.basename(full);
        if (ALWAYS_EXCLUDE.has(filename)) return false;
        if (EXCLUDE_EXCEPT_EXPLORE.has(filename) && stageId !== 'explore') return false;
        return true;
      });

      for (const full of filePaths) {
        const filename = path.basename(full);
        const relative = path.relative(root, full);
        const ext = path.extname(filename).toLowerCase();

        if (DATA_EXTS.has(ext)) {
          artifacts.push({ name: filename, path: relative, jobId });
          continue;
        }

        try {
          const stat = await fsp.stat(full);
          if (BINARY_EXTS.has(ext) || stat.size > MAX_TEXT_BYTES) {
            artifacts.push({ name: filename, path: relative, jobId, buffer: await fsp.readFile(full) });
          } else {
            artifacts.push({ name: filename, path: relative, jobId, content: await fsp.readFile(full, 'utf-8') });
          }
        } catch (err) {
          console.warn(`[${jobId}] Could not read artifact ${relative}:`, err.message);
          artifacts.push({ name: filename, path: relative, jobId });
        }
      }
    } catch (error) {
      console.error(`[${jobId}] Error getting artifacts:`, error.message);
    }

    console.log(`[${jobId}] Collected ${artifacts.length} artifact(s)`);
    return artifacts;
  }

  async stopJob(jobId) {
    const run = this.activeRuns.get(jobId);
    if (!run) return false;
    try {
      run.child.kill('SIGTERM');
      // Escalate if the agent ignores the polite request.
      setTimeout(() => { try { run.child.kill('SIGKILL'); } catch { /* already gone */ } }, 10000).unref();
      this.activeRuns.delete(jobId);
      const tid = this.timeoutHandles.get(jobId);
      if (tid) { clearTimeout(tid); this.timeoutHandles.delete(jobId); }
      return true;
    } catch (error) {
      console.error(`Error stopping job ${jobId}:`, error.message);
      this.activeRuns.delete(jobId);
      return false;
    }
  }

  isJobRunning(jobId) { return this.activeRuns.has(jobId); }

  getActiveJobs() {
    return Array.from(this.activeRuns.entries()).map(([jobId, info]) => ({
      jobId, containerId: `pid:${info.child.pid}`, runningTime: Date.now() - info.startTime,
    }));
  }

  async healthCheck() {
    // Use lstat, not existsSync: the venv's bin/python is a symlink to the
    // interpreter's path *inside* the image, so from the host it always looks
    // dangling and existsSync would report a healthy environment as missing.
    const present = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

    const missing = [];
    if (!present(rc.SIF_PATH)) missing.push(`image ${rc.SIF_PATH}`);
    if (!present(path.join(rc.VENV_DIR, 'pyvenv.cfg'))) missing.push(`python env ${rc.VENV_DIR}`);
    if (!present(path.join(rc.NODE_DIR, 'bin', 'claude'))) missing.push(`claude CLI in ${rc.NODE_DIR}`);

    const version = await new Promise((resolve) => {
      const probe = spawn(rc.SINGULARITY_BIN, ['--version']);
      let out = '';
      probe.stdout.on('data', (d) => { out += d.toString(); });
      probe.on('error', () => resolve(null));
      probe.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });

    return {
      healthy: missing.length === 0 && version !== null,
      runtime: 'singularity',
      singularityVersion: version,
      agentImageExists: fs.existsSync(rc.SIF_PATH),
      missing,
      error: missing.length ? `Not provisioned: ${missing.join(', ')}` : undefined,
    };
  }
}

module.exports = new SingularityManager();
module.exports.SingularityManager = SingularityManager;
