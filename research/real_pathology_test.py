# ═══════════════════════════════════════════════════════════════════
# REAL PATHOLOGY TEST
#
# Everything so far has been measured against a synthetic dark ellipse I
# invented. That tests whether the model detects the ellipse. This tests
# whether the model detects disease, which is the actual question.
#
# Kermany ships four labelled classes; you trained on NORMAL and have never
# touched the other three:
#   CNV    choroidal neovascularisation  - subretinal fluid, large, high contrast
#   DME    diabetic macular oedema        - intraretinal cysts, mid contrast
#   DRUSEN sub-RPE deposits               - SMALL and LOW CONTRAST
#
# DRUSEN is the one that decides the company. It is the published failure mode
# of every uncertainty-as-anomaly method, and it is exactly the early-AMD
# population an optometrist most needs help with. Expect CNV to work and
# drusen to be hard; if drusen also separates, that is a genuinely strong
# result and worth writing up.
#
# Metric is AUC, not Cohen's d. These are different patients, so the groups are
# unpaired and the between-scan spread is large; AUC is rank-based and immune
# to that. AUC 0.5 = no signal, 0.7 = usable, 0.8+ = strong.
#
# Runtime: ~15s/scan, 4 classes x N_PATH scans. Start with N_PATH=20 (~20 min).
# ═══════════════════════════════════════════════════════════════════
import os, glob
import numpy as np
from sklearn.metrics import roc_auc_score

N_PATH = 20

# --- locate the labelled folders ---
CLASS_PATHS = {}
for cls in ["NORMAL", "CNV", "DME", "DRUSEN"]:
    hits = sorted(glob.glob(os.path.join(root, "**", cls, "*.jpeg"), recursive=True))
    CLASS_PATHS[cls] = hits
    print(f"{cls:7s} {len(hits):>7,} images")

assert all(len(v) > N_PATH for v in CLASS_PATHS.values()), \
    "Some class folders are empty - check `root` from the section-2 download cell."


def load_path(p):
    im = Image.open(p).convert("L").resize((W, H))
    return np.asarray(im, dtype=np.float32) / 255.0


def score_class(cls, n=N_PATH, offset=0):
    """Held-out scans only: skip the first N_TRAIN+N_VAL NORMALs the model saw."""
    paths = CLASS_PATHS[cls]
    start = (N_TRAIN + N_VAL + 100) if cls == "NORMAL" else 0
    out = []
    for p in paths[start + offset: start + offset + n]:
        x = load_path(p)
        mu, sd = mc_uncertainty(x)
        z = anomaly_score(x, mu, sd)
        out.append(uncertainty_stats(z, retina_mask(mu)))
    return out


import time
t0 = time.time()
S = {cls: score_class(cls) for cls in ["NORMAL", "CNV", "DME", "DRUSEN"]}
print(f"\n{4*N_PATH} scans in {time.time()-t0:.0f}s\n")

# --- AUC of each statistic for separating each pathology from NORMAL ---
print(f"{'':9s} {'u_total':>9s} {'top_mass':>9s} {'blob_share':>11s}   n")
print("-" * 46)
for cls in ["CNV", "DME", "DRUSEN"]:
    row = [cls]
    for k in ("u_total", "top_mass", "blob_share"):
        neg = [s[k] for s in S["NORMAL"]]
        pos = [s[k] for s in S[cls]]
        y = [0] * len(neg) + [1] * len(pos)
        auc = roc_auc_score(y, neg + pos)
        row.append(f"{auc:.3f}")
    print(f"{row[0]:9s} {row[1]:>9s} {row[2]:>9s} {row[3]:>11s}   {len(S[cls])}")

print("\nAUC 0.50 = no signal | 0.70 = usable | 0.80+ = strong")
print("An AUC well BELOW 0.50 is also a finding - the statistic is inverted, not dead.")

# --- distributions, for eyeballing overlap ---
fig, ax = plt.subplots(1, 3, figsize=(15, 3.4))
cols = {"NORMAL": "#1A5FC8", "CNV": "#C25200", "DME": "#E0A529", "DRUSEN": "#7B3F98"}
for a, k in zip(ax, ["u_total", "top_mass", "blob_share"]):
    for cls, c in cols.items():
        a.hist([s[k] for s in S[cls]], bins=12, alpha=.55, label=cls, color=c)
    a.set_title(k); a.legend(fontsize=7)
plt.suptitle("Real pathology vs normal - this is the test that matters")
plt.tight_layout(); plt.show()

# --- look at the worst and best cases individually ---
worst_cls = "DRUSEN"
p = CLASS_PATHS[worst_cls][0]
x = load_path(p)
mu, sd = mc_uncertainty(x)
z = anomaly_score(x, mu, sd)
fig, ax = plt.subplots(1, 4, figsize=(16, 2.8))
for a, (im, t, cm) in zip(ax, [(x, f"real {worst_cls}", "gray"),
                               (mu, "model's expectation", "gray"),
                               (np.abs(x - mu), "raw residual", "inferno"),
                               (z, "residual z", "inferno")]):
    a.imshow(im, cmap=cm); a.set_title(t, fontsize=9); a.axis("off")
plt.suptitle("Does the residual land ON the pathology, or somewhere irrelevant?")
plt.show()
