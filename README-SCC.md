# EcoXAI on BU SCC

How to set up and run this fork of [EcoXAI](https://github.com/EpistasisLab/EcoXAI)
on the Boston University Shared Computing Cluster. Upstream assumes Docker;
SCC has no Docker daemon, so this fork adds a Singularity runtime
(`ecoxai/backend/singularity/`) and a headless batch driver. Everything
else — the pipeline, the skills, the GUI — is unchanged.

If you only want to know what EcoXAI *does*, read the upstream [README](README.md)
first. This document is about running it here.

---

## 1. What you need

| | Where to get it |
|---|---|
| An SCC account with access to project `ai4ad` | your PI |
| Shared project storage (`/projectnb/ai4ad-presibo/$USER`) | created for you |
| An Anthropic API key with prepaid credits | https://console.anthropic.com → Settings → API keys, then **Plans & Billing → Buy credits**. A Claude.ai subscription does **not** count; the API bills separately. |
| Node.js 20+ | the cluster module `nodejs/8.2.1` is too old — install a binary into `~/opt/node20` (below) |
| Singularity/Apptainer | already on every SCC node |

Budget for planning: one full cycle on a 4 k-row table with Claude Opus costs
roughly **$1 (explore) + $1 (hypothesize) + $1.5 × number of hypotheses** — about
$15 for eight hypotheses. `CLAUDE_MODEL=claude-sonnet-5` cuts that by ~5×.

---

## 2. One-time setup

### 2.1 Node 20

```bash
mkdir -p ~/opt && cd ~/opt
curl -LO https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
tar xf node-v20.18.1-linux-x64.tar.xz && mv node-v20.18.1-linux-x64 node20
```

### 2.2 Shell environment

Append to `~/.bashrc`:

```bash
# ---- EcoXAI (Singularity runtime on SCC) ----
export PATH="$HOME/opt/node20/bin:$PATH"
# Runtime state: agent image, python env, node, workspaces, datasets.
# NOT /scratch — that is node-local and purged, so it is invisible from any
# other node. /projectnb is shared GPFS.
export ECOXAI_STATE_DIR=/projectnb/ai4ad-presibo/$USER/ecoxai
export ECOXAI_RUNTIME=singularity
```

### 2.3 Clone and install

```bash
mkdir -p ~/code/agent && cd ~/code/agent
git clone git@github.com:BUJunLab/EcoXAI-BUSCC.git EcoXAI
cd EcoXAI/ecoxai/backend

source /opt/rh/gcc-toolset-13/enable    # better-sqlite3 needs a C++20 compiler
npm install
```

To push back to GitHub from SCC you need an SSH key registered on your GitHub
account (`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github`, then add
`~/.ssh/id_ed25519_github.pub` at https://github.com/settings/ssh/new and point
`~/.ssh/config` at it).

### 2.4 Agent environment (~10 min, ~2.2 GB, no privilege needed)

```bash
./singularity/build-agent-env.sh
```

This pulls a stock `python:3.11` image read-only and builds the Python stack and
Node + Claude Code CLI beside it under `$ECOXAI_STATE_DIR/agent/`. Nothing is
installed *into* the image because `singularity build --fakeroot` needs an
`/etc/subuid` entry only an admin can grant. `ECOXAI_FORCE_REBUILD=1` rebuilds
from scratch.

### 2.5 `.env`

`ecoxai/backend/.env` is git-ignored. Create it:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ECOXAI_RUNTIME=singularity
ECOXAI_STATE_DIR=/projectnb/ai4ad-presibo/<you>/ecoxai

# Optional
# CLAUDE_MODEL=claude-sonnet-5
# ECOXAI_EXTRA_BINDS=/projectnb/ai4ad-presibo:/data/presibo:ro
```

Check the key works before spending a batch allocation on it:

```bash
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $(grep ^ANTHROPIC_API_KEY .env | cut -d= -f2)" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
```

A `credit balance is too low` reply means the console account needs credits;
the pipeline will start, spend nothing, and fail every stage three times.

---

## 3. Running

### 3.1 Batch (recommended)

The backend, the headless driver and every agent container run inside one
allocation, so nothing lingers on a login node.

```bash
# 1. the dataset — the watcher ingests anything dropped here on startup
cp mytable.csv ~/code/agent/EcoXAI/ecoxai/backend/datasets/

# 2. the research context (see §4 for what to write)
mkdir -p $ECOXAI_STATE_DIR/runs
cat > $ECOXAI_STATE_DIR/runs/context.txt <<'TXT'
One row per drug ... RESEARCH QUESTION: ...
TXT

# 3. submit
cd ~/code/agent/EcoXAI
SMOKE_FILENAME=mytable.csv SMOKE_BUDGET_USD=20 SMOKE_CYCLES=1 \
  qsub -N ecoxai-run -v SMOKE_FILENAME,SMOKE_BUDGET_USD,SMOKE_CYCLES \
  ecoxai/backend/singularity/scc/pipeline.qsub
```

Watch it:

```bash
qstat -u $USER
tail -f ecoxai-run.<jobid>.log           # driver: stage transitions + agent stdout
tail -f $ECOXAI_STATE_DIR/runs/backend.<jobid>.log
```

Knobs (all environment variables, all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SMOKE_FILENAME` | `ad_repurposing_smoke.csv` | file in `backend/datasets/` to run |
| `SMOKE_CONTEXT` | contents of `$OUT/context.txt` | description + research question |
| `SMOKE_BUDGET_USD` | 20 | hard stop; no new job starts past it |
| `SMOKE_CYCLES` | 1 | hypothesize→analyze rounds; `-1` = until budget |
| `SMOKE_DEADLINE_MIN` | 420 | driver gives up after this |
| `ECOXAI_AGENT_THREADS` | `NSLOTS/2` | BLAS/XGBoost thread clamp per agent |

The `#$ -pe omp 16` in the script gives two parallel analyze agents eight
cores each. Singularity has no cgroup limits — the scheduler is the only thing
bounding these jobs, so keep the thread clamp.

### 3.2 Interactive, with the GUI

```bash
qrsh -P ai4ad -pe omp 8 -l h_rt=04:00:00
cd ~/code/agent/EcoXAI && ./start.sh        # backend :8081, frontend :3000
hostname                                    # e.g. scc-xyz
```

From your laptop, tunnel both ports through the login node:

```bash
ssh -L 8081:scc-xyz:8081 -L 3000:scc-xyz:3000 you@scc1.bu.edu
```

then open http://localhost:3000. Datasets → click the file → fill Description
and Research Question → **Start Pipeline**.

Do **not** leave a backend running on a login node while a batch job runs
another one: both write the same `state.json` and will corrupt each other's
run. The backend takes a lock (`data/.backend.lock`) and the second one refuses
to start, but only after you've wasted a queue wait.

### 3.3 Where results go

| What | Where |
|---|---|
| per-job outputs: `report.md`, `verdict_results.json`, figures, scripts, `session.log` | `ecoxai/backend/assets/<jobId>-<title>/` |
| dataset wiki (portrait + discoveries) | `ecoxai/backend/data/wikis/` |
| hypotheses, verdicts, costs | `ecoxai/backend/data/executions.db` (SQLite) |
| batch run archive of all of the above | `$ECOXAI_STATE_DIR/runs/artifacts.<jobid>/` |
| `reset.sh` moves the above to | `$ECOXAI_STATE_DIR/archive/<timestamp>/` |

Workspaces under `$ECOXAI_STATE_DIR/workspaces/` are deleted as each job
finishes; `assets/` is the only copy. `./reset.sh` archives before wiping;
`./reset.sh --no-archive` does not.

Pull the hypothesis table out:

```bash
curl -s localhost:8081/api/hypotheses/export/csv > hypotheses.csv
sqlite3 ecoxai/backend/data/executions.db \
  'select id, hypothesis_type, status, confidence_score, substr(hypothesis_text,1,80) from hypotheses'
```

---

## 4. What to give it: the dataset and the query

EcoXAI takes **one table and one natural-language research question** per
run. The question is the query. It is injected into every agent prompt and
decides the direction of every hypothesis; the agents write and run their own
Python against the table to test them.

### 4.1 The table

- One file: `.csv`, `.feather`, `.parquet`, `.xlsx`, `.json`.
- One row per unit of analysis (sample, drug, gene…), one column per variable.
  The pipeline later reads only a single cleaned table, so join upstream.
- If there is an outcome column, name it so the skills find it
  (`target`, `label`, `outcome`, `diagnosis`); otherwise they assume the last
  column, which is usually wrong — say what the target is in the context.
- Do not put individual-level restricted data in without checking the DUA:
  agents send row excerpts to the API while reasoning. Aggregate first.

### 4.2 The context

Write it for a competent analyst who has never seen the data. Cover:
provenance of each column group, known weaknesses, what is a label and what is
not, and the question. Everything in it reaches the agents verbatim.

**Example — AD drug repurposing (the table under `ecoxai-data/`):**

> Alzheimer disease drug-repurposing screen, one row per drug (4382 rows).
> DRUG SIDE: Broad Drug Repurposing Hub gives clinical_phase, moa, disease_area,
> indication and the pipe-separated target gene list. PROTEOMIC EVIDENCE: BU ADRC
> plasma SomaScan, AD-vs-control, joined to each drug through its targets via
> UniProt; best_prot_p is the smallest p across a drug's targets, n_prot_p05
> counts targets under p<0.05, max_abs_prot_effect the largest absolute effect.
> This contrast is weak: nothing survives FDR. GENETIC EVIDENCE: Jansen 2019 AD
> GWAS, SNPs at p<1e-5 mapped to nearby genes; best_gwas_p, max_abs_gwas_z,
> n_targets_gwas summarise a drug's targets at those loci. GROUND TRUTH:
> known_ad_drug marks the 5 drugs the Hub lists for AD.
> RESEARCH QUESTION: which mechanism-of-action classes rank highest by the
> combined proteomic and genetic evidence, and do the known AD drugs surface
> near the top? Treat known_ad_drug as a held-out label, never as a predictor.
> If the evidence does not support a ranking, say so.

**Other research questions that fit the pipeline:**

- *Biomarker panel* — "Which plasma proteins best separate AD from controls
  after adjusting for age, sex and APOE4? Which survive FDR, and is any
  combination of ≤5 proteins better than the best single one?"
- *Subgroup / interaction* — "Does the proteomic AD signature differ between
  APOE4 carriers and non-carriers? Identify proteins whose association with AD
  is carrier-specific."
- *Target prioritisation* — "Rank the 843 GWAS-locus genes by convergence of
  genetic and proteomic evidence, and report which are targets of launched
  drugs."
- *Data quality* — "Is the AD-vs-control contrast confounded by batch, dilution
  group or age? Which columns are unusable and why?"

The more the question names the unit of analysis, the covariates, and what
counts as a positive result, the less the agents wander.

### 4.3 Knowledge-graph queries (optional)

The hypothesize stage can query a Neo4j/Memgraph graph (upstream targets
`bolt://alzkb.ai:7687`, reachable from SCC compute nodes). It is optional:
without it hypotheses come from the table alone. If you point it at a graph,
the skill under `ecoxai/backend/skills/hypotheses/alzkb-graph-query/` holds
the templates. Some that matter for repurposing (AlzKB labels; swap in your
own):

```cypher
// Drugs whose targets are AD-associated genes — candidate discovery
MATCH (dr:Drug)-[:CHEMICALBINDSGENE]->(g:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer'
RETURN dr.commonName AS drug, collect(DISTINCT g.geneSymbol) AS ad_targets
ORDER BY size(ad_targets) DESC LIMIT 100;

// Drugs already recorded as treating AD — held-out validation set
MATCH (dr:Drug)-[:DRUGTREATSDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer'
RETURN dr.commonName;

// Pathways a given drug's targets sit in — mechanism for a hypothesis
MATCH (dr:Drug {commonName: $drug})-[:CHEMICALBINDSGENE]->(g:Gene)-[:GENEINPATHWAY]->(p:Pathway)
RETURN g.geneSymbol AS gene, collect(p.commonName) AS pathways;

// Two-hop: drug → target → shares a pathway with an AD gene — indirect candidates
MATCH (dr:Drug)-[:CHEMICALBINDSGENE]->(g1:Gene)-[:GENEINPATHWAY]->(p:Pathway)
      <-[:GENEINPATHWAY]-(g2:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer' AND g1 <> g2
RETURN dr.commonName AS drug, count(DISTINCT g2) AS ad_neighbours
ORDER BY ad_neighbours DESC LIMIT 50;

// Genes at a GWAS locus that no launched drug touches — white space
MATCH (g:Gene)-[:GENEASSOCIATESWITHDISEASE]->(d:Disease)
WHERE toLower(d.commonName) CONTAINS 'alzheimer'
  AND NOT (:Drug)-[:CHEMICALBINDSGENE]->(g)
RETURN g.geneSymbol;
```

Use `toLower(x) CONTAINS 'term'`, never `x =~ '(?i)…'`: alzkb.ai runs on
Memgraph, whose regex engine rejects inline flags, and a rejected query makes
the agent silently drop the graph and fall back to the table.

### 4.4 Mounting more data

Agents see only `/workspace`, `/datasets` (read-only) and the runtime. To let
them read other files, bind them read-only:

```bash
ECOXAI_EXTRA_BINDS=/projectnb/ai4ad-presibo/shared:/lake/shared:ro:/restricted/projectnb/ai4ad/original_drug:/lake/drug:ro
```

and tell them what is there in the context (or a `DATA_CATALOG.md` next to the
dataset). The default skills only read the cleaned table; giving the agents a
lake without also editing the explore skill just costs turns.

---

## 5. Changing what the agents do

Stage behaviour lives in `ecoxai/backend/skills/public/pipeline-{explore,hypothesize,analyze}/SKILL.md`
and the stage prompts at the top of `ecoxai/backend/orchestrator.js`. Editing
those changes the pipeline; the backend does not need to be touched. They can
also be edited live in the GUI (Pipeline → click a stage).

Things the stock skills assume that you may need to change for a new problem:

- explore imputes missing values with the median, clips numerics at 3×IQR and
  drops duplicates — destructive for evidence tables where missing means
  "not measured" and the values are p-values;
- hypothesis types are column-level (`feature_importance`, `biomarker`,
  `risk_factor`…), not entity-level (drug, MoA class, target);
- analyze centres on cross-validated models and permutation importance.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| every stage fails 3× with exit 1, cost $0, log says `Credit balance is too low` | console account has no credits (§1) |
| `ERROR: a backend still holds this state directory` | another backend (maybe on another node) has `data/.backend.lock`; stop it, or `ECOXAI_FORCE_UNLOCK=1` if it is dead |
| scheduler kills the job; `ps` showed an agent on 12+ cores | thread clamp missing — set `ECOXAI_AGENT_THREADS` |
| agent env "not found" on a compute node | `ECOXAI_STATE_DIR` points at `/scratch`; move it to `/projectnb` and rebuild |
| `ALZKB_UNAVAILABLE` in the hypothesize log | graph query rejected; usually a `(?i)` regex, see §4.3 |
| `npm install` fails on `better-sqlite3` | `source /opt/rh/gcc-toolset-13/enable` first |
| backend starts but ingests nothing | filename extension not in csv/json/feather/parquet/xlsx, or it is already in `state.json` |
| second dataset file appears as a separate pipeline | by design: one file = one dataset = one pipeline. Join first. |

Known gaps versus the Docker image are listed in
[`ecoxai/backend/singularity/README.md`](ecoxai/backend/singularity/README.md).
