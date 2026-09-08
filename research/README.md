# research/

The model work behind `RealEngine`. None of this ships in the app — the app runs on
`MockEngine` and will until a model is validated across vendors.

Read this before touching the notebook. It is mostly a record of things that did not
work, which is more useful than the code.

---

## The idea

Train a model on **normal retinal anatomy only**, leave dropout on at inference, and run
it 20 times on the same scan. Where it has seen this kind of anatomy often, all 20 passes
agree. Where it hasn't, they disagree. Then the **spatial shape** of that disagreement
decides what to do:

| Shape | Meaning | Outcome |
|---|---|---|
| flat, at layer boundaries only | model agrees with itself | cleared |
| spread evenly across the image | the image is bad, not the eye | rescan |
| concentrated in one region | image is fine, anatomy is unfamiliar | review |

The mechanism is not new — see Seebock et al., *IEEE TMI* 2019, and Ball et al. 2025.
What is ours is the decision rule, the thresholds, and the workflow around them. **Do not
claim the concept is novel**; a reviewer will find the prior art in an afternoon.

---

## What was tried, in order

### v1 — reconstruction autoencoder. Failed.

A U-Net trained to reconstruct its input. Val loss 0.0086, which looked excellent and
meant the opposite: skip connections let it copy pixels straight through, so it never had
to understand anything. Injecting a lesion produced no response at all (d = +0.04).

Two supporting bugs found along the way:
- The retina mask used an intensity percentile, which selects vitreous and choroid rather
  than retina in real Spectralis data. Every statistic was computed over the wrong pixels.
- The degradation model led with Gaussian blur. For a reconstruction task blur *removes*
  the high-frequency detail that is hard to predict, so degraded scans scored **calmer**
  than clean ones. Backwards.

### v2 — masked inpainting. Half worked.

Hide a patch, predict it from context, compute loss only inside the hole. Copying becomes
impossible. Val loss rose to 0.035 on a genuinely harder task, and the fill continued the
retinal layers plausibly.

Degraded finally separated from clean (d = +0.49). The anomaly signal was still zero, for
a reason that is obvious once seen: **the sliding hole erases the lesion before the model
sees it.** The model confidently inpaints normal retina and all 20 passes agree, because
normal retina is what it knows. Variance goes *down* at a lesion.

Inpainting variance answers "how ambiguous is the normal anatomy here". It does not answer
"is what is actually here abnormal".

### v3 — the residual. Works, modestly.

Use the quantity v2 computed and threw away:

```
z = |x - mean_fill| / (std_fill + eps)
```

How far the observed content sits from what the model expected, in units of how sure the
model was about that expectation.

---

## Results

Trained on Kermany NORMAL only (108k labelled B-scans, Spectralis, `Cell` 2018), 18
epochs, ~12 minutes on a T4. Tested on 100 held-out scans per class the model never saw.

### Real pathology vs normal — AUC

| | AUC | 95% CI | read |
|---|---|---|---|
| CNV `u_total` | **0.755** | 0.69 – 0.82 | usable |
| DME `u_total` | **0.693** | 0.62 – 0.77 | usable |
| DRUSEN `u_total` | 0.572 | 0.49 – 0.65 | **at chance** |

The ordering matters as much as the numbers. Large high-contrast subretinal fluid detects
best, intraretinal oedema next, small low-contrast sub-RPE deposits worst — exactly the
gradient the literature predicts for uncertainty-based anomaly detection. Noise does not
produce a theoretically coherent ordering.

### Capture failure vs clean — paired, n=25

| statistic | direction | consistency | p |
|---|---|---|---|
| `u_total` | up | 21/25 scans | 0.0016 |
| `blob_share` | down | 18/25 scans | 0.020 |

Higher overall residual, less spatially concentrated. That is the diffuse signature, and
it holds scan by scan. **The rescan outcome is the better-supported half of the product.**

### What did not survive scrutiny

At n=20, `top_mass` looked like it beat `u_total` on drusen (0.667 vs 0.575), which would
have been the shape thesis appearing in the data on its own. At n=100 it collapsed to
0.581. It was small-sample noise. Treat any n=20 result here as a hypothesis, not a
finding.

---

## What these numbers do and do not support

**Do:** a model that never saw a diseased retina separates real CNV from normal at AUC
0.76. The mechanism works, without a single pathology label in training.

**Do not:** anything clinical. Single dataset, single vendor, internal validation, 12
minutes of training, no comparison against a clinician, no prospective data. Cleared
devices sit at 0.95+.

**The honest one-sentence version:** *on held-out Kermany scans, uncertainty-based triage
separates CNV from normal at AUC 0.76 [0.69–0.82] and DME at 0.69 [0.62–0.77], with early
drusen at chance.*

Say the drusen limitation out loud. Early AMD is the population an optometrist most needs
help with, and it is the documented failure mode of this whole family of methods —
the network keeps segmenting confidently around a small drusen and stays calm. Volunteering
that earns more credibility than a claim to catch everything.

---

## Files

| file | what it is |
|---|---|
| `Coherence_RealEngine_v3.ipynb` | the notebook. Colab, T4, ~35 min end to end |
| `real_pathology_test.py` | paste-in cell: AUC against real CNV / DME / DRUSEN |
| `paired_check.py` | paste-in cell: paired stats where groups are the same scans |

The notebook's own section 11 lists the debugging order if section 7 comes back flat.

---

## Next, in priority order

1. **Deep ensemble instead of MC dropout.** Five models at different seeds. The literature
   consistently finds ensembles calibrate better for selective referral, and it is the
   first thing a technical reviewer will ask about.
2. **Multi-vendor validation on RETOUCH** (112 volumes, 11,334 B-scans, Cirrus +
   Spectralis + Topcon). Report per-vendor metrics separately or the number means nothing.
   The vendor-neutral claim is a commercial promise and a technical liability at once.
3. **Risk–coverage curve and AURC on the cleared bucket.** The cleared bucket is where
   patient harm would occur, so it is the bucket that needs the error bar.
4. **Replace the thickness placeholder.** `layerThicknessUm` is currently a tissue-row
   count times a scale factor. It looks like a measurement and is not one. Real layer
   segmentation plus the DICOM pixel spacing, before it goes near a clinician.
5. **Move off Colab.** The same FastAPI app on Modal or Fly with a persistent URL. The
   ngrok tunnel dies every session and is fine for a demo, not for a pilot.

Keep `ENGINE_ENV = "mock"` and the mock banner visible until at least 1 and 2 are done.
