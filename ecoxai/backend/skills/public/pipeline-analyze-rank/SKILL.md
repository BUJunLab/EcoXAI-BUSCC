---
name: pipeline-analyze-rank
description: Test one drug-repurposing hypothesis on an evidence table with ranking and enrichment methods, target-level ablation and negative controls; write a standard verdict
when: use for the test/validate phase on a drug-level evidence table after pipeline-hypothesize-drug
visibility: public
tags: [pipeline, analyze, repurposing, enrichment, ablation, ranking]
author: system
version: 1.0.0
---

## Instructions

You test **one** hypothesis (in task.txt, `**Hypothesis:**`) against the drug
table and the drug×target table. Write small Python scripts, run them, and
produce the two contract files. Do not test other hypotheses. Do not re-derive
the dataset.

| File | Description |
|---|---|
| `output/verdict_results.json` | one verdict for `HYPOTHESIS_ID` |
| `output/report.md` | what was tested, how, the numbers, the figures, the caveats |

### Setup

```python
import os, json, requests, numpy as np, pandas as pd
import pyarrow.feather as feather
from scipy import stats

dataset_id = os.environ['DATASET_ID']; hyp_id = int(os.environ.get('HYPOTHESIS_ID', 0))
backend = os.environ.get('BACKEND_URL', 'http://host.docker.internal:8081')
df = feather.read_feather(f'/datasets/{dataset_id}/cleaned/data.feather')
dt = pd.read_csv('/reference/ad_repurposing_v2_drug_targets.csv')
hyp = next(h for h in requests.get(f'{backend}/api/hypotheses', timeout=10).json()['hypotheses'] if h['hypothesis_id'] == hyp_id)
print(hyp['hypothesis_type'], '|', hyp['hypothesis_text']); print('pre-registered:', hyp['expected_metric'])
```

If `HYPOTHESIS_ID` is 0 or not found, stop and write a verdict of
`needs_more_data` with reasoning "hypothesis id not resolvable" — never fall
back to testing every hypothesis.

### The skeleton every test follows

Run these four blocks in order; the verdict is not written until all four exist.

**1. Primary test — exactly the pre-registered statistic.** Compute what
`expected_metric` names, on the label it names. Labels are `ad_trial_any`
(default), `ad_trial_phase3plus` or `known_ad_drug`; they are never inputs.
Report the statistic, its CI (bootstrap 1000× over drugs) and p.

**2. Target-level ablation.** Repeat the primary test after each of:
- collapsing every shared target to one vote (keep one drug per
  `best_prot_target` when `best_prot_target_nshare > 5`, chosen at random,
  repeated 200× → distribution of the statistic);
- removing all drugs whose `best_prot_target` is the single most-shared target
  among the positives (for this table, ACHE);
- for `signature_reversal`: recomputing with `prot_aptamers_concordant == 1` only.
Report each. A result that does not survive the first two is not supported.

**3. Negative controls.** At least two:
- label permutation (1000×): the statistic under shuffled labels;
- matched null: the same statistic for random drug sets matched on `n_targets`
  and `n_targets_measured` (polypharmacology and coverage are the confounders
  that ranked Aurora-kinase inhibitors #1 by GWAS proximity);
- for class/pathway claims: random classes of the same size.
Report where the observed statistic sits in each null (empirical p).

**4. Direction and coverage check.** How many positives actually carry the
channel the claim uses (e.g. positives with `n_targets_l2g > 0`); whether the
direction of the effect matches the chain in the hypothesis (`action_dir ×
prot_dir`). If fewer than 5 positives carry the channel, the verdict cannot be
`supported`.

### Verdict rules

- `supported`: primary test meets the pre-registered threshold **and** survives
  both ablations **and** sits beyond the 95th percentile of both nulls **and**
  ≥5 positives carry the channel.
- `rejected`: primary test clearly fails, or an ablation or control reproduces
  the effect (the effect is the artifact).
- `needs_more_data`: everything else — underpowered, channel missing for the
  positives, ablation inconclusive.
- For `evidence_artifact` and `label_validity` hypotheses, "supported" means the
  artifact / weakness is demonstrated by the ablation or control.

### Figures

At least one: the primary statistic with its bootstrap CI beside the two null
distributions (histogram + observed line), and the ablation series as points
with intervals. Label axes with the statistic's name and the label used.

### verdict_results.json

```json
[{
  "hypothesis_id": 12,
  "verdict": "supported | rejected | needs_more_data",
  "actual_importance": 2.31,
  "reasoning": "primary: <stat> = x [CI] p=; ablation: shared-target collapse → y [range], ACHE removed → z; controls: permutation p=, matched-null p=; positives carrying channel: n/146; direction: consistent|inconsistent; caveats.",
  "ablation_robust": true,
  "negative_control_p": 0.003,
  "positives_with_channel": 41,
  "label_used": "ad_trial_any",
  "contradicts": []
}]
```

`contradicts` lists hypothesis ids from the API whose stored verdict this result
logically conflicts with (e.g. an artifact you confirmed is the signal another
"supported" verdict relied on). Leave it `[]` only after checking. End with
`print("SKILL_INVOKED: public:pipeline-analyze-rank")`.
