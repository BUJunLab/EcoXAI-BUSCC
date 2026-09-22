// Headless driver for an unattended EcoXAI run (no browser). Connects to the
// backend WebSocket, sets the research context, budget and cycle count, starts
// the pipeline and exits when every job has settled or the deadline passes.
// /api/pipeline/status returns orchestrator config only; datasets, jobs and
// budget live in the WebSocket FULL_STATE payload the frontend consumes.
const WebSocket = require('ws');

const BASE = 'http://localhost:8081';
const FILENAME = process.env.SMOKE_FILENAME || 'ad_repurposing_smoke.csv';
const CONTEXT = process.env.SMOKE_CONTEXT;
const BUDGET_USD = Number(process.env.SMOKE_BUDGET_USD || 3);
const CYCLES = Number(process.env.SMOKE_CYCLES || 1);
const DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MIN || 45) * 60000;

const t0 = Date.now();
const stamp = () => `[${String(Math.floor((Date.now() - t0) / 1000)).padStart(4)}s]`;
const log = (...a) => console.log(stamp(), ...a);

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

const TERMINAL = new Set(['complete', 'completed', 'failed', 'error', 'stopped']);
const RUNNING = new Set(['in-progress', 'running', 'queued', 'pending']);
const seen = new Map();
let settleTimer = null;
let budget = 0;
let triggered = false;
let exiting = false;

function finish(code, why) {
  if (exiting) return;
  exiting = true;
  log('=== DONE:', why, '===');
  log('jobs:');
  for (const [id, j] of seen) {
    log(`  ${id}  stage=${j.stage || j.type || '?'}  status=${j.status}` +
        (j.totalCostUsd != null ? `  $${j.totalCostUsd}` : '') +
        (j.error ? `\n      error: ${j.error}` : ''));
  }
  log(`budget spent: $${budget.toFixed(4)}`);
  process.exit(code);
}

function track(job, label) {
  if (!job || !job.id) return;
  const prev = seen.get(job.id);
  seen.set(job.id, { ...(prev || {}), ...job });
  if (!prev || prev.status !== job.status) {
    log(`${label} ${job.id} ${job.stage || job.type || '?'} -> ${job.status}`);
  }
  if (seen.size && [...seen.values()].every(j => TERMINAL.has(j.status))) {
    clearTimeout(settleTimer);
    // The orchestrator chains stages, so a lull is not the end. Only call it
    // done if nothing new starts within the grace window.
    settleTimer = setTimeout(() => finish(0, 'all jobs settled'), 90000);
  }
}

const ws = new WebSocket('ws://localhost:8081');

ws.on('open', () => log('ws connected'));
ws.on('error', e => { log('ws error:', e.message); finish(1, 'ws error'); });
ws.on('close', () => log('ws closed'));

ws.on('message', async raw => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch { return; }

  if (m.type === 'FULL_STATE') {
    budget = m.budget?.totalCostUsd || 0;
    (m.jobs || []).forEach(j => track(j, 'existing'));
    if (triggered) return;
    const ds = (m.datasets || []).find(d => d.filename === FILENAME);
    if (!ds) return finish(1, `dataset ${FILENAME} not in FULL_STATE`);
    triggered = true;
    log(`dataset: ${ds.id} (${ds.recordCount} rows x ${ds.columnCount} cols, status=${ds.status})`);

    if (CONTEXT) {
      log('setting research context…', JSON.stringify(await api('PUT', `/api/datasets/${ds.id}`, { userContext: CONTEXT })));
    }
    log('capping budget/cycles…', JSON.stringify(await api('PUT', '/api/settings', {
      budgetLimitUsd: BUDGET_USD, maxHypothesisCycles: CYCLES, maxParallelJobs: 2,
    })));
    // "Start Pipeline" in the UI is pipeline/resume: it enables auto-advance and
    // runs _normalizeAndStart on pending datasets, then explore -> hypothesize ->
    // analyze fire off their own triggers.
    log('starting pipeline (resume)…',
        JSON.stringify(await api('POST', '/api/pipeline/resume', {})));

    // resume() only advances from a completed job, a pending dataset, or an
    // active dataset with no jobs at all. An already-normalized dataset whose
    // explore job died on start falls through all three, so nudge it directly.
    setTimeout(async () => {
      // Ask the backend rather than trusting the local view of events.
      const st = await api('GET', '/api/pipeline/status').catch(() => ({}));
      const active = (st.active || []).length > 0
        || [...seen.values()].some(j => !TERMINAL.has(j.status));
      if (active) return;
      log('resume produced no running job — triggering explore directly');
      log('  ->', JSON.stringify(await api('POST', '/api/pipeline/trigger/explore',
                                           { datasetId: ds.id })));
    }, 45000);
    return;
  }

  if (m.type === 'BUDGET_UPDATE') {
    budget = m.budget?.totalCostUsd || budget;
    log(`budget: $${budget.toFixed(4)} over ${m.budget?.jobCount ?? '?'} job(s)`);
    return;
  }

  // JOB_UPDATE carries the whole job list under `jobs`; JOB_COMPLETED /
  // JOB_FAILED / JOB_STOPPED carry only a jobId. Neither has a `job` field, so
  // the earlier `m.job || m` never tracked anything, `seen` stayed empty, the
  // 45-second fallback re-triggered explore on top of the one already running,
  // and "all jobs settled" could never fire.
  if (m.type === 'JOB_UPDATE') {
    (m.jobs || (m.job ? [m.job] : [])).forEach(j => track(j, 'update  '));
    return;
  }
  if (m.type === 'JOB_COMPLETED' || m.type === 'JOB_FAILED' || m.type === 'JOB_STOPPED') {
    const id = m.jobId || m.job?.id;
    const status = m.type === 'JOB_COMPLETED' ? 'complete' : m.type === 'JOB_FAILED' ? 'failed' : 'stopped';
    if (id) track({ ...(seen.get(id) || {}), ...(m.job || {}), id, status, exitCode: m.exitCode },
                  m.type === 'JOB_COMPLETED' ? 'complete' : 'FAILED  ');
    return;
  }

  if (m.type === 'JOB_OUTPUT') {
    // The agent's own stdout — the real evidence that the container ran.
    const text = (m.output || m.chunk || m.data || '').toString().trimEnd();
    if (text) text.split('\n').slice(-3).forEach(l => log('  agent |', l.slice(0, 220)));
    return;
  }

  if (m.type === 'PIPELINE_STAGE_UPDATE') {
    if (m.stageId || m.status) {
      log(`stage ${m.stageId || '?'} -> ${m.status || '?'}` + (m.detail ? ` (${m.detail})` : ''));
    }
    return;
  }

  if (m.type === 'DATASETS_PROMOTED') {
    const ds = (m.datasets || []).find(d => d.filename === FILENAME);
    if (ds) log(`dataset status -> ${ds.status}`);
  }
});

setTimeout(() => finish(2, `deadline ${DEADLINE_MS / 60000} min reached`), DEADLINE_MS);
