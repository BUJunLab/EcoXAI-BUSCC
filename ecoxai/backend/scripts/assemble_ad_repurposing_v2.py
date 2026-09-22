"""
Build the v2 EcoXAI input tables for AD drug repurposing.

Two tables, so the pipeline can reason at the level where the evidence lives:

  ad_repurposing_v2_drug_targets.csv   one row per (drug, target gene)
  ad_repurposing_v2_drugs.csv          one row per drug, aggregated from the above

What v2 adds over v1, each answering a failure the 2026-09-22 run exposed:

  - direction: DrugCentral ACTION_TYPE (inhibitor/agonist/...) x SomaScan logFC
    sign -> does the drug oppose or mimic the AD change in its target protein?
    v1's |effect| had no sign, so "evidence" could not mean "reversal".
  - shared-target size: how many Hub drugs share each target. v1's min-p summary
    let 40 ACHE binders inherit one identical value and rank as 40 hits.
  - aptamer handling: SomaScan carries 2 ACHE aptamers (p=0.012 and p=0.49);
    v1 kept the min. v2 keeps the min but reports n_aptamers and concordance.
  - Open Targets L2G genes for the Jansen 2019 GWAS (36 credible sets, top gene
    per locus) beside the v1 nearest-gene list at p<1e-5 (843 genes, which put
    AURKA and VKORC1 at the top of the MoA ranking).
  - ClinicalTrials.gov: every drug with an interventional AD trial, with its
    highest phase. 145 Hub drugs, versus 5 known_ad_drug positives.

Everything read here is public reference data or aggregate summary statistics.
No individual-level records are touched.
"""
import re
import numpy as np
import pandas as pd

AI4AD = "/restricted/projectnb/ai4ad"
DRUG  = f"{AI4AD}/original_drug"
HUB   = f"{DRUG}/BIDRH_repurposing_drugs_20170327.txt"
DC    = f"{DRUG}/drugcentral_drug.target.interaction.tsv"
DB    = f"{DRUG}/drugbank_protein_all.csv"
PROT  = f"{AI4AD}/adrc_gmp_db_project/plasma_proteomics_adreagan_results.csv"
GWAS  = ("/restricted/projectnb/adgc/_Association.Summary.Data/"
         "AD_Jansen.etal.NatGene.2019_UKBB/AD_sumstats_Jansenetal.p1e-5.tophits.annot")
HERE  = "/projectnb/ai4ad-presibo/scho1/ecoxai-data/v2"
L2G   = f"{HERE}/opentargets_jansen2019_l2g.csv"
CTG   = f"{HERE}/ctgov_ad_interventions.csv"
OUT_T = f"{HERE}/ad_repurposing_v2_drug_targets.csv"
OUT_D = f"{HERE}/ad_repurposing_v2_drugs.csv"

KNOWN_AD = {"citicoline", "donepezil", "physostigmine", "rivastigmine", "tacrine"}

rd = lambda p, **k: pd.read_csv(p, dtype=str, encoding="latin-1", **k)
num = lambda s: pd.to_numeric(s, errors="coerce")

# ---------------------------------------------------------------- drug side
hub = rd(HUB, sep="\t")
hub = hub[hub["target"].notna()].copy()
pairs = (hub.assign(gene=hub["target"].str.split("|"))
            .explode("gene")
            .assign(gene=lambda d: d["gene"].str.strip().str.upper())
            .query("gene != ''")
            [["pert_iname", "gene"]]
            .drop_duplicates())
print(f"Hub: {pairs.pert_iname.nunique()} drugs, {len(pairs)} drug-target pairs")

# --------------------------------------------- DrugCentral: action type per pair
dc = rd(DC, sep="\t")
dc = (dc.assign(gene=dc["GENE"].fillna("").str.split(r"[|;]"),
                acc=dc["ACCESSION"].fillna("").str.split(r"[|;]"))
        .explode("gene").explode("acc"))
dc["gene"] = dc["gene"].str.strip().str.upper()
dc["acc"] = dc["acc"].str.strip()
dc["drug"] = dc["DRUG_NAME"].str.strip().str.lower()
dc = dc[(dc.gene != "") & (dc.acc != "")]

NEG = {"INHIBITOR", "ANTAGONIST", "BLOCKER", "NEGATIVE ALLOSTERIC MODULATOR", "GATING INHIBITOR",
       "INVERSE AGONIST", "NEGATIVE MODULATOR", "ANTISENSE INHIBITOR", "RELEASING AGENT"}  # last two rare
POS = {"AGONIST", "ACTIVATOR", "OPENER", "POSITIVE ALLOSTERIC MODULATOR", "POSITIVE MODULATOR",
       "PARTIAL AGONIST", "STABILISER", "STIMULATOR", "INDUCER"}
def action_dir(a):
    if not isinstance(a, str): return np.nan
    a = a.strip().upper()
    if a in NEG: return -1.0
    if a in POS: return 1.0
    return 0.0
dc["action_type"] = dc["ACTION_TYPE"].str.strip().str.upper()
dc["action_dir"] = dc["action_type"].map(action_dir)
# one action per (drug, gene): prefer a signed one
act = (dc.sort_values("action_dir", key=lambda s: s.abs(), ascending=False)
         .drop_duplicates(["drug", "gene"])[["drug", "gene", "action_type", "action_dir"]])
pairs["drug"] = pairs["pert_iname"].str.strip().str.lower()
pairs = pairs.merge(act, on=["drug", "gene"], how="left")
n_dc = pairs.action_dir.abs().eq(1).sum()
# Fallback: the Hub's own MoA string ("acetylcholinesterase inhibitor",
# "dopamine receptor agonist") names the action for every target the Hub lists.
moa = hub.drop_duplicates("pert_iname").set_index("pert_iname")["moa"].fillna("").str.lower()
def moa_dir(m):
    if re.search(r"\b(inhibitor|antagonist|blocker|inverse agonist|negative)\b", m): return -1.0
    if re.search(r"\b(agonist|activator|opener|stimulant|positive|inducer|enhancer)\b", m): return 1.0
    return np.nan
fb = pairs.pert_iname.map(moa).map(moa_dir)
fill = pairs.action_dir.isna() | pairs.action_dir.eq(0)
pairs.loc[fill & fb.notna(), "action_dir"] = fb[fill & fb.notna()]
pairs.loc[fill & fb.notna(), "action_type"] = "MOA:" + pairs.loc[fill & fb.notna(), "pert_iname"].map(moa).str.upper()
print(f"action direction: {n_dc} pairs from DrugCentral, "
      f"{pairs.action_dir.abs().eq(1).sum()} after Hub-MoA fallback, of {len(pairs)}")

# ------------------------------------------------- gene symbol -> UniProt
db = rd(DB)[["Gene Name", "UniProt ID"]].dropna(); db.columns = ["gene", "acc"]
sym2acc = (pd.concat([dc[["gene", "acc"]], db])
             .assign(gene=lambda d: d["gene"].str.strip().str.upper(), acc=lambda d: d["acc"].str.strip())
             .query("gene != '' and acc != ''").drop_duplicates())

# ------------------------------------------------------- proteomic evidence
prot = rd(PROT, sep="\t")[["AD-ControllogFC", "AD-ControlP.Value", "AD-Controladj.P.Val", "Target.Name", "UniProt.ID", "SomaID"]]
prot.columns = ["prot_logfc", "prot_p", "prot_adj_p", "soma_target", "acc", "soma_id"]
for c in ("prot_logfc", "prot_p", "prot_adj_p"): prot[c] = num(prot[c])
prot = prot.dropna(subset=["prot_p"])
prot = (prot.assign(acc=prot["acc"].fillna("").str.split(r"[|,; ]+")).explode("acc").query("acc != ''"))
# per protein: the aptamer with the smallest p, plus how many aptamers and whether their signs agree
def agg_protein(g):
    g = g.reset_index(drop=True)   # explode() left duplicate index labels
    i = g.prot_p.idxmin(); best = g.loc[i]
    signs = np.sign(g.prot_logfc.dropna())
    return pd.Series(dict(prot_logfc=best.prot_logfc, prot_p=best.prot_p, prot_adj_p=best.prot_adj_p,
                          prot_n_aptamers=len(g), prot_aptamers_concordant=int(signs.nunique() <= 1),
                          prot_min_p_other_aptamer=(g.prot_p.drop(i).min() if len(g) > 1 else np.nan)))
by_acc = prot.groupby("acc").apply(agg_protein).reset_index()
gene_acc = sym2acc.drop_duplicates("gene")  # one accession per symbol for the join
pt = pairs.merge(gene_acc, on="gene", how="left").merge(by_acc, on="acc", how="left")
# fallback: SomaScan target label == symbol (rare)
by_sym = (prot.assign(gene=prot["soma_target"].str.strip().str.upper()).groupby("gene").apply(agg_protein).reset_index())
miss = pt.prot_p.isna()
fb = pt.loc[miss, ["gene"]].merge(by_sym, on="gene", how="left")
for c in by_sym.columns.drop("gene"):
    pt.loc[miss, c] = fb[c].values
pt["prot_dir"] = np.sign(pt["prot_logfc"])
print(f"proteomic: {pt.prot_p.notna().sum()} pairs measured, {pt.loc[pt.prot_p.notna(),'pert_iname'].nunique()} drugs")

# reversal: drug lowers a protein that is up in AD, or raises one that is down
pt["reversal"] = np.where(pt.action_dir.isin([1, -1]) & pt.prot_dir.isin([1, -1]),
                          -(pt.action_dir * pt.prot_dir), np.nan)  # +1 opposes AD change, -1 mimics it
pt["reversal_p05"] = ((pt.reversal == 1) & (pt.prot_p < 0.05)).astype(int)
pt["mimic_p05"] = ((pt.reversal == -1) & (pt.prot_p < 0.05)).astype(int)

# ------------------------------------------ genetic evidence 1: nearest gene
gw = pd.read_csv(GWAS, sep=r"\s+", dtype=str, encoding="latin-1")
gw["P"] = num(gw["P-value"]); gw["Z"] = num(gw["Z"])
def loci_genes(row):
    out = set()
    w = row["WITHIN"]
    if isinstance(w, str) and w != ".": out.update(s.strip().upper() for s in w.split(",") if s.strip())
    for col in ("UP", "DOWN"):
        v = row[col]
        if not isinstance(v, str) or v == ".": continue
        for item in v.split(","):
            m = re.match(r"^\d+_(.+)$", item.strip())
            if m: out.add(m.group(1).strip().upper())
    return out
rows = [(g, r["P"], r["Z"]) for _, r in gw.iterrows() for g in loci_genes(r)]
gwas_gene = (pd.DataFrame(rows, columns=["gene", "gwas_sugg_p", "gwas_sugg_z"]).dropna(subset=["gwas_sugg_p"])
               .sort_values("gwas_sugg_p").drop_duplicates("gene"))
pt = pt.merge(gwas_gene, on="gene", how="left")

# ------------------------------------------ genetic evidence 2: Open Targets L2G
l2g = pd.read_csv(L2G, dtype=str)
l2g["l2g_score"] = num(l2g["l2g"]); l2g["l2g_rank"] = num(l2g["l2g_rank"])
l2g["gene"] = l2g["gene"].str.upper()
l2g_best = (l2g.sort_values("l2g_score", ascending=False).drop_duplicates("gene")
              [["gene", "l2g_score", "l2g_rank", "locus"]].rename(columns={"locus": "l2g_locus"}))
l2g_best["is_l2g_top"] = (l2g_best.l2g_rank == 1).astype(int)
pt = pt.merge(l2g_best, on="gene", how="left")

# ------------------------------------------------ shared-target artifact size
share = pairs.groupby("gene").pert_iname.nunique().rename("n_drugs_sharing_gene")
pt = pt.merge(share, on="gene", how="left")

pt = pt.rename(columns={"pert_iname": "drug_name", "acc": "uniprot"})
pt = pt[["drug_name", "gene", "uniprot", "action_type", "action_dir",
         "prot_logfc", "prot_p", "prot_adj_p", "prot_dir", "prot_n_aptamers", "prot_aptamers_concordant", "prot_min_p_other_aptamer",
         "reversal", "reversal_p05", "mimic_p05",
         "gwas_sugg_p", "gwas_sugg_z", "l2g_score", "l2g_rank", "is_l2g_top", "l2g_locus",
         "n_drugs_sharing_gene"]].sort_values(["drug_name", "gene"])
pt.to_csv(OUT_T, index=False)
print(f"wrote {OUT_T}  {pt.shape[0]} rows x {pt.shape[1]} cols")

# --------------------------------------------------- ClinicalTrials.gov label
ct = pd.read_csv(CTG, dtype=str); ct = ct[ct.itype == "DRUG"].copy()
SALT = r"\b(hydrochloride|hcl|sodium|mesylate|maleate|tartrate|sulfate|sulphate|citrate|acetate|succinate|fumarate|bromide|tablets?|capsules?|oral|injection|iv|mg|placebo|extended release|er|xr|sr)\b"
def norm(s):
    s = str(s).lower(); s = re.sub(r"\(.*?\)", " ", s); s = re.sub(SALT, " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()
PH = ["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4"]
ct["n"] = ct.iname.map(norm)
ct["phases"] = ct.phase.fillna("").str.split("|")
ct = ct.explode("phases"); ct["ph_i"] = ct.phases.map(lambda p: PH.index(p) if p in PH else -1)
hub_norm = pd.DataFrame({"drug_name": pairs.pert_iname.unique()}); hub_norm["n"] = hub_norm.drug_name.map(norm)
ctm = ct.merge(hub_norm, on="n")
trial = ctm.groupby("drug_name").agg(ad_trial_n=("nct", "nunique"), ph_i=("ph_i", "max")).reset_index()
trial["ad_trial_max_phase"] = trial.ph_i.map(lambda i: PH[i] if i >= 0 else "NA")
trial = trial.drop(columns="ph_i")
print(f"ClinicalTrials.gov: {len(trial)} Hub drugs with an interventional AD trial")

# ------------------------------------------------------------- drug table
g = pt.groupby("drug_name")
def first_gene_min(df, col):
    d = df.dropna(subset=[col])
    return d.loc[d[col].idxmin(), "gene"] if len(d) else np.nan
drugs = pd.DataFrame({
    "n_targets": g.gene.nunique(),
    "targets": g.gene.apply(lambda s: "|".join(sorted(set(s)))),
    "n_targets_with_action": g.action_dir.apply(lambda s: s.abs().eq(1).sum()),
    # proteomic
    "n_targets_measured": g.prot_p.count(),
    "best_prot_p": g.prot_p.min(),
    "n_prot_p05": g.prot_p.apply(lambda s: (s < 0.05).sum()),
    "n_prot_up_p05": g.apply(lambda d: ((d.prot_p < 0.05) & (d.prot_dir > 0)).sum()),
    "n_prot_down_p05": g.apply(lambda d: ((d.prot_p < 0.05) & (d.prot_dir < 0)).sum()),
    "max_abs_prot_logfc": g.prot_logfc.apply(lambda s: s.abs().max()),
    "best_prot_target": g.apply(lambda d: first_gene_min(d, "prot_p")),
    "best_prot_target_nshare": g.apply(lambda d: d.loc[d.prot_p.idxmin(), "n_drugs_sharing_gene"] if d.prot_p.notna().any() else np.nan),
    "best_prot_target_n_aptamers": g.apply(lambda d: d.loc[d.prot_p.idxmin(), "prot_n_aptamers"] if d.prot_p.notna().any() else np.nan),
    # direction
    "n_reversal": g.reversal.apply(lambda s: (s == 1).sum()),
    "n_reversal_p05": g.reversal_p05.sum(),
    "n_mimic_p05": g.mimic_p05.sum(),
    # genetic: suggestive nearest-gene
    "n_targets_gwas_sugg": g.gwas_sugg_p.count(),
    "best_gwas_sugg_p": g.gwas_sugg_p.min(),
    "max_abs_gwas_sugg_z": g.gwas_sugg_z.apply(lambda s: s.abs().max()),
    # genetic: L2G
    "n_targets_l2g": g.l2g_score.count(),
    "n_targets_l2g_top": g.is_l2g_top.sum(),
    "max_l2g_score": g.l2g_score.max(),
    "l2g_genes": g.apply(lambda d: "|".join(sorted(d.loc[d.l2g_score.notna(), "gene"]))),
    # artifact flags
    "max_shared_target_n": g.n_drugs_sharing_gene.max(),
}).reset_index()

meta = hub.drop_duplicates("pert_iname").set_index("pert_iname")
drugs["clinical_phase"] = drugs.drug_name.map(meta["clinical_phase"])
drugs["is_launched"] = (drugs.clinical_phase == "Launched").astype(int)
drugs["moa"] = drugs.drug_name.map(meta["moa"])
drugs["disease_area"] = drugs.drug_name.map(meta["disease_area"])
drugs["indication"] = drugs.drug_name.map(meta["indication"])
drugs["is_cns"] = drugs.disease_area.fillna("").str.contains("neurology|psychiatry", case=False).astype(int)
drugs["known_ad_drug"] = drugs.drug_name.str.lower().isin(KNOWN_AD).astype(int)
drugs = drugs.merge(trial, on="drug_name", how="left")
drugs["ad_trial_n"] = drugs.ad_trial_n.fillna(0).astype(int)
drugs["ad_trial_max_phase"] = drugs.ad_trial_max_phase.fillna("NONE")
drugs["ad_trial_any"] = (drugs.ad_trial_n > 0).astype(int)
drugs["ad_trial_phase3plus"] = drugs.ad_trial_max_phase.isin(["PHASE3", "PHASE4"]).astype(int)

drugs = drugs[["drug_name", "clinical_phase", "is_launched", "moa", "disease_area", "indication", "is_cns",
               "known_ad_drug", "ad_trial_any", "ad_trial_n", "ad_trial_max_phase", "ad_trial_phase3plus",
               "n_targets", "targets", "n_targets_with_action",
               "n_targets_measured", "best_prot_p", "n_prot_p05", "n_prot_up_p05", "n_prot_down_p05", "max_abs_prot_logfc",
               "best_prot_target", "best_prot_target_nshare", "best_prot_target_n_aptamers",
               "n_reversal", "n_reversal_p05", "n_mimic_p05",
               "n_targets_gwas_sugg", "best_gwas_sugg_p", "max_abs_gwas_sugg_z",
               "n_targets_l2g", "n_targets_l2g_top", "max_l2g_score", "l2g_genes",
               "max_shared_target_n"]].sort_values("drug_name")
drugs.to_csv(OUT_D, index=False)
print(f"wrote {OUT_D}  {drugs.shape[0]} rows x {drugs.shape[1]} cols")
print("known AD drugs:", drugs.known_ad_drug.sum(), "| AD-trial drugs:", drugs.ad_trial_any.sum(),
      "| phase3+:", drugs.ad_trial_phase3plus.sum(), "| drugs with any L2G target:", (drugs.n_targets_l2g > 0).sum(),
      "| drugs with a reversal_p05:", (drugs.n_reversal_p05 > 0).sum())
