---
name: pipeline-hypothesize-drug
description: Generate entity-level drug-repurposing hypotheses (drug, target, MoA class, pathway, signature reversal), each with a mechanism chain and a pre-registered test against a held-out label; store them via the backend API
when: use for the hypothesis phase on a drug-level evidence table after pipeline-explore-evidence has run
visibility: public
tags: [pipeline, hypothesize, repurposing, drug, target, moa, mechanism]
author: system
version: 1.0.0
---

## Instructions

You are the hypothesis phase of a drug-repurposing pipeline. Generate 6–10
**entity-level** hypotheses about drugs, targets, mechanism-of-action classes or
pathways, store them through the API, and stop. Do not test them.

Read first, in this order:
1. `/workspace/exploration_report.md` — especially its **Traps** list. A hypothesis
   that walks into a listed trap is wrong before it is tested.
2. `/reference/DATA_CATALOG.md` — every column of both tables.
3. task.txt — the research question. Every hypothesis serves it.
4. Existing hypotheses from the API (step 2 below) — do not duplicate.

### Hypothesis types (choose the most specific)

| type | claim shape | the test it commits to |
|---|---|---|
| `drug_candidate` | drug X is a repurposing candidate for AD via target T | X's evidence chain holds under target-level ablation and beats matched controls |
| `target_prioritization` | gene T is a better AD target than the field, by convergent evidence | T's channels agree; drugs on T are enriched for AD trial entry vs drugs on comparable genes |
| `moa_class_enrichment` | MoA class C is enriched for AD trial-entry drugs, beyond what its shared targets explain | class-level enrichment survives collapsing shared targets to one vote |
| `pathway_convergence` | pathway P is where proteomic and genetic evidence converge | overlap of P's genes across channels exceeds a gene-set permutation null |
| `signature_reversal` | drugs whose action opposes the AD change in their targets are enriched for AD trial entry | `n_reversal_p05` vs `n_mimic_p05` enrichment, ablating ACHE |
| `evidence_artifact` | a ranking signal is a structural artifact (shared target, aptamer, polypharmacology, positional mapping) | ablation removes the signal; controls reproduce it |
| `label_validity` | the held-out label is (not) informative for this channel | positives' evidence collapses to k independent cases |

### Rules

1. **Mechanism chain.** Every `drug_candidate`, `target_prioritization`,
   `pathway_convergence` and `signature_reversal` hypothesis names its chain:
   drug → target (with `action_dir`) → protein change in AD (`prot_dir`, `prot_p`)
   or locus (`l2g_score`) → disease. A hypothesis without a chain is a
   `evidence_artifact` or `label_validity` hypothesis or it is not a hypothesis.
2. **Held-out labels only.** `known_ad_drug`, `ad_trial_any`, `ad_trial_phase3plus`,
   `ad_trial_max_phase` are validation labels. They never appear as predictors,
   filters or scoring inputs. Prefer `ad_trial_any` (146 positives) over
   `known_ad_drug` (5, effectively one target).
3. **Shared targets vote once.** Any claim about a drug or class must state how it
   handles `best_prot_target_nshare` / `n_drugs_sharing_gene`. Forty ACHE binders
   are one observation about ACHE, not forty about drugs.
4. **Pre-register the test.** `expected_metric` is a concrete, falsifiable
   statement with the statistic, the null, the threshold and the ablation:
   "enrichment OR > 2 for ad_trial_any among class C drugs vs all others, Fisher
   p < 0.01 after collapsing each shared target to one drug; must survive
   removing ACHE-target drugs."
5. **Diversity.** At least four types across the batch; at most three of any one
   type; at least one `evidence_artifact` and one `label_validity` unless the
   exploration report shows those questions are already settled.
6. **Novelty.** Not semantically equivalent to any existing hypothesis
   (`novelty_rationale` says what is new).

### Steps

```python
import os, json, requests, pandas as pd, numpy as np
import pyarrow.feather as feather

dataset_id = os.environ['DATASET_ID']; job_id = os.environ['JOB_ID']; run_id = os.environ.get('RUN_ID')
backend = os.environ.get('BACKEND_URL', 'http://host.docker.internal:8081')
df = feather.read_feather(f'/datasets/{dataset_id}/cleaned/data.feather')
dt = pd.read_csv('/reference/ad_repurposing_v2_drug_targets.csv')

existing = requests.get(f'{backend}/api/hypotheses', timeout=10).json().get('hypotheses', [])
print(len(existing), 'existing'); [print(' ', h['hypothesis_type'], '|', h['hypothesis_text'][:90]) for h in existing]
```

Ground each hypothesis in numbers you compute here (class sizes, how many
drugs a target is shared by, how many positives have the channel). Do not test
the hypothesis — compute only what is needed to make it specific and
falsifiable.

```python
hypotheses = [
  {
    "hypothesis_text": "one sentence, entity named, mechanism chain named, direction stated",
    "hypothesis_type": "drug_candidate | target_prioritization | moa_class_enrichment | pathway_convergence | signature_reversal | evidence_artifact | label_validity",
    "confidence_score": 0.55,
    "expected_metric": "statistic, null, threshold, ablation — see rule 4",
    "feature_name": "the entity: drug name, gene symbol, MoA string or pathway name",
    "novelty_rationale": "what this adds over existing hypotheses"
  },
]
payload = {"job_id": job_id, "run_id": run_id or None, "hypotheses": hypotheses}
r = requests.post(f'{backend}/api/hypotheses', json=payload, timeout=15); r.raise_for_status()
created = r.json().get('created', []); assert created, r.text
print(f'Stored {len(created)} hypotheses')
```

Write `output/report.md`: the diversity analysis (types and entities covered,
what the exploration Traps ruled out), then each hypothesis with its chain and
its pre-registered test. End with `print("SKILL_INVOKED: public:pipeline-hypothesize-drug")`.
