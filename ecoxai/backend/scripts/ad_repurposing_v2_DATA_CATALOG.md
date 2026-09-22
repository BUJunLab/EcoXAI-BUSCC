# AD drug-repurposing evidence tables, v2 (built 2026-09-22)

Two tables. The pipeline ingests the drug table; the drug×target table is
mounted read-only at `/reference/` for any agent that needs target-level detail.
Everything is public reference data or aggregate summary statistics; no
individual-level records.

## Sources

| Channel | Source | Join |
|---|---|---|
| Drug identity, MoA, targets | Broad Institute Drug Repurposing Hub, 2017-03-27 release (6,798 drugs; 4,382 with ≥1 target) | `pert_iname`, `target` (pipe-separated HGNC symbols) |
| Action type | DrugCentral drug–target interaction table (`ACTION_TYPE`); fallback: the Hub `moa` string | drug name + gene; MoA words inhibitor/antagonist/blocker → −1, agonist/activator/opener → +1 |
| Proteomic | BU ADRC plasma SomaScan, AD vs control limma contrast, 7,217 aptamers | gene → UniProt (DrugCentral + DrugBank) → SomaScan `UniProt.ID`. Per protein: the aptamer with the smallest p; multiplicity reported |
| Genetic, suggestive | Jansen et al. 2019 AD GWAS, SNPs at p<1e-5, annotated nearest genes (WITHIN/UP/DOWN) — 843 genes | gene symbol |
| Genetic, L2G | Open Targets Platform, study GCST007320 (Jansen 2019, n=455,258), 36 credible sets, locus-to-gene predictions | gene symbol; `l2g_rank` 1 = top gene for its locus |
| Trial label | ClinicalTrials.gov API v2, interventional studies with condition "Alzheimer Disease", DRUG interventions (6,371 rows, 1,568 names) | normalised name match to Hub (salts, formulations stripped); 146 Hub drugs match |

Known weaknesses: the SomaScan contrast is weak (134 of 7,217 at raw p<0.05,
nothing at FDR<0.05). ACHE (P22303) has two aptamers that disagree (p=0.012 vs
0.49, opposite sign); 40 Hub drugs share ACHE. Name matching to trials is exact
after normalisation, so brand names and codes (e.g. "Aricept") are missed.

## `ad_repurposing_v2_drugs.csv` — one row per drug (4,382 × 35)

| Column | Meaning |
|---|---|
| `drug_name` | Hub `pert_iname` |
| `clinical_phase`, `is_launched` | Hub development stage; `is_launched` = phase is "Launched" |
| `moa`, `disease_area`, `indication` | Hub annotations; may be empty |
| `is_cns` | `disease_area` contains neurology or psychiatry |
| **Labels — held-out, never predictors** | |
| `known_ad_drug` | 1 for the 5 drugs the Hub lists for AD (citicoline, donepezil, physostigmine, rivastigmine, tacrine) |
| `ad_trial_any` | 1 if any interventional AD trial lists the drug (146) |
| `ad_trial_n` | number of such trials |
| `ad_trial_max_phase` | highest phase among them: EARLY_PHASE1 / PHASE1–4 / NA (phase not given) / NONE (no trial) |
| `ad_trial_phase3plus` | 1 if PHASE3 or PHASE4 (61) |
| **Targets** | |
| `n_targets`, `targets` | count and pipe-separated list of Hub target genes |
| `n_targets_with_action` | targets with a signed action direction |
| **Proteomic (per drug, over its measured targets)** | |
| `n_targets_measured` | targets with a SomaScan aptamer |
| `best_prot_p` | smallest raw p across measured targets |
| `n_prot_p05`, `n_prot_up_p05`, `n_prot_down_p05` | measured targets with p<0.05; split by direction of change in AD |
| `max_abs_prot_logfc` | largest |logFC| across measured targets (SomaScan units, not comparable across proteins) |
| `best_prot_target` | the gene that supplies `best_prot_p` |
| `best_prot_target_nshare` | how many Hub drugs share that gene — the shared-target artifact size |
| `best_prot_target_n_aptamers` | aptamers measuring that gene's protein |
| **Direction** | |
| `n_reversal` | targets where the drug's action opposes the protein's AD change (inhibitor × up, activator × down) |
| `n_reversal_p05` | of those, with p<0.05 |
| `n_mimic_p05` | targets where the drug's action reproduces the AD change, p<0.05 |
| **Genetic** | |
| `n_targets_gwas_sugg`, `best_gwas_sugg_p`, `max_abs_gwas_sugg_z` | targets among the 843 nearest genes at suggestive loci; best p / |z| |
| `n_targets_l2g`, `n_targets_l2g_top`, `max_l2g_score`, `l2g_genes` | targets among Open Targets L2G genes for the 36 genome-wide significant loci; top-ranked ones; best score; the genes |
| **Artifact flag** | |
| `max_shared_target_n` | largest `n_drugs_sharing_gene` over the drug's targets |

## `ad_repurposing_v2_drug_targets.csv` — one row per (drug, target) (12,056 × 22)

| Column | Meaning |
|---|---|
| `drug_name`, `gene`, `uniprot` | pair identity |
| `action_type`, `action_dir` | DrugCentral action or `MOA:<hub moa>`; −1 inhibits/antagonises, +1 activates/agonises, 0 other, NaN unknown |
| `prot_logfc`, `prot_p`, `prot_adj_p`, `prot_dir` | SomaScan AD-vs-control for the target protein (best aptamer); sign of logFC |
| `prot_n_aptamers`, `prot_aptamers_concordant`, `prot_min_p_other_aptamer` | aptamer multiplicity; 1 if all aptamers agree in sign; the next-best aptamer's p |
| `reversal` | +1 drug opposes the AD change, −1 mimics it, NaN if either direction unknown |
| `reversal_p05`, `mimic_p05` | the same, restricted to p<0.05 |
| `gwas_sugg_p`, `gwas_sugg_z` | suggestive-locus nearest-gene statistics |
| `l2g_score`, `l2g_rank`, `is_l2g_top`, `l2g_locus` | Open Targets L2G for the gene, if any |
| `n_drugs_sharing_gene` | Hub drugs with this gene as a target |
