---
name: pipeline-explore-evidence
description: Profile a drug-level evidence table for repurposing without altering it; measure channel coverage, shared-target structure and label strength; write the exploration report the hypothesis and analysis agents rely on
when: use for the exploration phase when the dataset is an entity-level evidence table (one row per drug, gene or protein) rather than a sample × feature matrix
visibility: public
tags: [pipeline, explore, evidence, repurposing, profiling]
author: system
version: 1.0.0
---

## Instructions

You are the exploration phase for an **evidence table**: one row per drug, columns
that summarise independent evidence channels (proteomic, genetic, trial history)
joined through the drug's targets. Your job is to describe the table so that the
hypothesis and analysis agents do not fall into its traps. You do not generate or
test hypotheses. Stop once `exploration_report.md` is written.

### Do not clean

This is not a sample matrix. Missing means **not measured** (a target with no
SomaScan aptamer, no GWAS locus), not a value to impute. The numeric columns are
p-values, effect sizes and counts whose extremes are the signal.

- Do not impute. Do not clip or winsorise. Do not drop rows.
- Do not drop duplicates: none exist by construction (one row per drug).
- `output/cleaned_data.feather` must be the input table **unchanged** in values,
  with dtypes fixed (numeric columns numeric, flags int). Downstream agents read
  this file; if you change values here, every verdict inherits the change.

### Read the catalog first

`/reference/DATA_CATALOG.md` documents every column
and the second table at `/reference/ad_repurposing_v2_drug_targets.csv` — one row
per (drug, target gene) with per-target p-values, effect direction, drug action
direction, L2G scores and `n_drugs_sharing_gene`. Load both.

```python
import pandas as pd, numpy as np, json, os, glob
import pyarrow.feather as feather

dataset_id = os.environ.get('DATASET_ID', '')
base = f'/datasets/{dataset_id}/normalized'
tables = sorted(glob.glob(f'{base}/tables/table_*.feather'))
df = feather.read_table(tables[0]).to_pandas()
dt = pd.read_csv('/reference/ad_repurposing_v2_drug_targets.csv') if os.path.exists('/reference/ad_repurposing_v2_drug_targets.csv') else None
print(df.shape, None if dt is None else dt.shape)
```

### What to measure (each becomes a section of the report)

1. **Channel coverage.** For each evidence channel — proteomic (`n_targets_measured`,
   `best_prot_p`), suggestive GWAS (`n_targets_gwas_sugg`), L2G (`n_targets_l2g`),
   direction (`n_targets_with_action`) — how many drugs have *any* value, and how
   that coverage depends on `n_targets`. A channel that only covers drugs with many
   targets will rank polypharmacology, not biology.

2. **Shared-target structure.** From the long table: the genes with the largest
   `n_drugs_sharing_gene`; for each, how many drugs inherit an identical
   `best_prot_p` from it (`best_prot_target`, `best_prot_target_nshare`). List every
   gene that alone accounts for ≥10 drugs' best proteomic value. This is the
   artifact that made 40 ACHE binders look like 40 hits.

3. **Aptamer multiplicity.** Proteins with `prot_n_aptamers > 1`, and among them
   those whose aptamers disagree (`prot_aptamers_concordant == 0`) or whose other
   aptamer is far from significant (`prot_min_p_other_aptamer`). Name any
   frequently-shared target whose "hit" rests on one of two aptamers.

4. **Label strength.** Counts for `known_ad_drug`, `ad_trial_any`,
   `ad_trial_phase3plus`, and the phase distribution. How many positives have each
   evidence channel at all? If the positives share one target (check
   `best_prot_target` across positives), say that the label is effectively one
   independent case for that channel.

5. **Direction.** How many pairs have a signed action and a signed protein change;
   how many drugs have `n_reversal_p05 > 0` or `n_mimic_p05 > 0`; which targets
   drive those.

6. **Column notes.** A short table: column, type, non-missing count, what it means,
   and any caveat found above. Downstream agents quote this.

### Required outputs

| File | Description |
|---|---|
| `output/cleaned_data.feather` | the input table, values unchanged, dtypes fixed |
| `output/exploration_report.md` | sections 1–6, with numbers, plus a **"Traps"** list at the top: the 3–6 things a hypothesis about this table must not do |

Write the Traps list first and in plain language, e.g. "Do not treat a drug's
best proteomic p as evidence for the drug when `best_prot_target_nshare` > 10 —
it is evidence for the gene." End with `print("SKILL_INVOKED: public:pipeline-explore-evidence")`.
