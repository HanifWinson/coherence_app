# Go-to-market — Weeks 1 & 3

Build Club *Braided Pathway*: Week 1 is **Scope & Wedge** (1-sentence offer + 29 named
prospects), Week 3 is **Demand & Pre-sell** (live landing page + a real buying signal / LOI).
This folder is both.

Everything here is a draft to argue with, not a finding. The numbers you fill in during the
calls are the finding.

---

## 1. The one-sentence offer

> **Coherence sorts every OCT scan into cleared, rescan or review, so your optometrists only
> open the ones that actually need a human.**

Why this sentence:
- It sells the outcome the PRD calls the product — *scans you didn't have to open* — not the
  model.
- It says **rescan**, the outcome nobody else has. A practice feels a bad capture found
  after the patient has gone home.
- It says nothing about diagnosis. Keep it that way (PRD §1, and see §5 below).

Alternates to A/B on calls — note which one makes people lean in:
- *"Find the bad OCT captures while the patient is still in the chair."* (rescan-first wedge)
- *"An OCT second reader that tells you when it isn't sure."* (confidence-first)

## 2. Ideal customer profile (the wedge)

Start narrow. Widen only after 3 LOIs from the same segment.

| | Wedge ICP |
|---|---|
| Who | Independent or small-group optometry practice (1–5 locations), Australia |
| Has | An OCT device in routine use — note the vendor (Spectralis, Cirrus, Topcon, Maestro…) |
| Volume | Enough OCT that reviewing every scan is a real cost — ask, don't assume |
| Buyer | Practice owner (usually also an optometrist) |
| User | Optometrists reviewing scans; techs/front desk doing captures (uploader role) |
| Pain to listen for | Review backlog · recalls for bad captures · locums reading OCT unevenly · anxiety about missed findings |
| Disqualify | No OCT · hospital/ophthalmology dept (different buyer, longer cycle) · wants a diagnosis |

**Vendor matters twice.** It's your multi-vendor validation plan (PRD §10, research
README) *and* a sales filter. Record it for every prospect; the first vendor with 3 LOIs
is the one you validate on first.

## 3. The 29 prospects

Use [`prospects.csv`](prospects.csv). One row per practice, not per person.

Where to find them — you pick and name them; don't buy lists:
- Your own and your network's optometrists (warmest; start here)
- Optometry Australia state divisions, CPD events, local optometry meetups
- Uni optometry alumni (UNSW, QUT, Flinders, Deakin, UC)
- Practices whose websites advertise OCT scans

Only record business contact details people have published or given you, and note how you
got each lead in the `source` column.

## 4. The call — 20 minutes, mostly listening

Don't demo first. Ask, then show.

1. *"Walk me through what happens to an OCT scan after it's captured."*
2. *"How many scans a week? Who looks at them? How long does that take?"*
3. *"When did a bad capture last cost you — a recall, a rebook?"*
4. *"If a scan got flagged 'rescan' while the patient was still seated, what would change?"*
5. *"What would you worry about with a tool like this?"* — listen for trust, liability,
   workflow, vendor lock-in.
6. **Then** demo: load the 12 sample scans, show the report headline and one Review case,
   and click Disagree. The mock banner stays on — say it's canned data, out loud.
7. The ask: *"Would you sign a non-binding letter of intent to pilot it when it's ready?"*
   → send them to the landing page's LOI form while you're still on the call.

After each call fill in `pain_quote` with their exact words. Those quotes are your Week 7
pitch.

## 5. What we must not say or sell yet

Coherence is almost certainly **software as a medical device** once it's used to triage
patients' scans — the PRD already reasons about TGA classification. That's why the LOI
is **non-binding and conditional**, and why the landing page says "in development — not
available for clinical use".

- Don't call any output a diagnosis. Don't promise accuracy numbers to practices; the
  research numbers are single-vendor internal validation.
- Don't take money for clinical use before the regulatory path is clear. Get advice from a
  regulatory consultant before Week 5 (Pricing & Payments) — it decides what you can charge
  for and when. Options worth asking them about: a paid **non-clinical** evaluation, LOIs
  conditional on registration, or selling the de-identification/workflow pieces on their own.

## 6. Scoreboard (update weekly)

| Metric | Wk 1 | Wk 2 | Wk 3 | Wk 4 |
|---|---|---|---|---|
| Prospects named | /29 | | | |
| Calls held | | | | |
| Demos given | | | | |
| LOIs signed | | | | |
| Price band most chosen | | | | |

Pull LOIs from the database with `npm run leads` (writes `gtm/leads.csv`, git-ignored).
