# ═══════════════════════════════════════════════════════════════════
# PASTE AND RUN NOW — uses s_clean / s_anom already in memory.
# No recomputation. ~1 second.
#
# s_clean[i] and s_anom[i] are the SAME SCAN, with and without a lesion.
# Cohen's d treats them as independent groups, so the 5.6x between-scan
# spread in u_total (p10 0.167 -> p90 0.939) lands in the denominator and
# buries a lesion occupying ~4% of the mask. The paired test removes it:
# each scan is its own control.
# ═══════════════════════════════════════════════════════════════════
from scipy import stats as sps
import numpy as np

def paired_report(a_list, b_list, label_a, label_b):
    print(f"\n{label_a} vs {label_b}  (paired, n={len(a_list)})")
    print(f"  {'stat':11s} {'mean delta':>11s} {'dz':>7s} {'won':>7s} {'p':>10s}")
    print("  " + "-" * 50)
    for k in ("u_total", "top_mass", "blob_share"):
        a = np.array([s[k] for s in a_list])
        b = np.array([s[k] for s in b_list])
        d = a - b
        dz = d.mean() / max(d.std(ddof=1), 1e-12)
        won = int((d > 0).sum())
        try:
            p = sps.wilcoxon(a, b).pvalue
        except ValueError:
            p = float("nan")
        flag = "  <<<" if abs(dz) > 0.8 else ""
        print(f"  {k:11s} {d.mean():+11.4f} {dz:+7.2f} {won:4d}/{len(d)} {p:10.2e}{flag}")

paired_report(s_anom,  s_clean, "anomalous", "clean")
paired_report(s_degra, s_clean, "degraded",  "clean")

# Per-scan detail for the anomaly: is the lesion raising the score consistently,
# or is a couple of scans carrying everything?
d_top = np.array([a["top_mass"] - c["top_mass"] for a, c in zip(s_anom, s_clean)])
d_blob = np.array([a["blob_share"] - c["blob_share"] for a, c in zip(s_anom, s_clean)])
print(f"\nlesion raised top_mass in   {int((d_top > 0).sum())}/{len(d_top)} scans")
print(f"lesion raised blob_share in {int((d_blob > 0).sum())}/{len(d_blob)} scans")
print("(consistently >60% means a real but small effect; ~50% means genuinely nothing)")
