# Handoff — 2026-09-28

Where Coherence stands, what was decided and why, and what to do next. Read this first,
then `README.md`, then `research/README.md`.

## Decisions

- **This repo (`coherence-app`) is the product.** The PRD (Vite + React, in-browser
  de-identification, cleared / rescan / review) describes it. The PRD itself is in
  `C:\Users\HP\coherence\prd\` — it is not in this repo yet.
- **`C:\Users\HP\coherence` (Next.js) is spare parts, not a second app.** It breaks PRD §2/§11:
  it uploads and stores the raw DICOM and has a patient-identifier column, and its triage is
  a single uncertainty score. Worth reusing later: the FastAPI skeleton in `ml-service/`
  (DICOM loading, tests, Dockerfile). Not its model approach.
- **Backend is a small Hono API next to Vite**, not a framework migration. Better Auth +
  Drizzle on Postgres; embedded PGlite in dev so nothing needs installing.
- **No model is trained.** The app runs `MockEngine` (canned results, banner on screen). The
  Colab results in `research/README.md` (CNV AUC 0.76, DME 0.69, drusen ≈ chance) have no
  saved weights anywhere. This machine has no NVIDIA GPU.
- **Customers before model.** Following the Build Club 8-week plan: Weeks 1–3 are offer,
  prospects and LOIs, which the mock demo is enough for. Model training and multi-vendor
  validation come after the first practice commits (PRD §10: no real model before vendor
  validation).

## State of the code

Branch `feat/auth-persistence` (not pushed, not merged):

| Commit | What |
|---|---|
| `e6aa85d` | Auth, persistence, history. PRD build-order steps 5–6. |
| `b342297` | Go-to-market kit: `gtm/`, `landing.html`, `/api/interest`, `npm run leads` |

Built and working:
- Sign-in; practice registration makes an admin; admin adds uploaders and reviewers.
  Public sign-up is blocked.
- Sign-off gated server-side to reviewers with an AHPRA-format number.
- Batches, decisions, disagreements and the audit log persist. Only derived numbers and
  heatmaps are stored — the schema has no patient / DOB / file / pixel columns.
- Audit log is append-only (DB trigger). Every query is scoped to the practice.
- History: search by case ID or date, reopen a report (heatmap + numbers; the scan is gone
  by design and the UI says so).
- Auto-lock after 5 min; unlock needs the password.
- Landing page with a non-binding LOI + price-band form.

## Run and test

```bash
npm install
npm run dev                 # app http://localhost:5173 · landing /landing.html · API :8787
npm test                    # 48 de-id + 90-fixture false-positive suite + 49 API/DB checks
npm run test:fixtures       # needs python + pydicom; rebuilds tests/fixtures (git-ignored)
npm run leads               # landing-page sign-ups -> gtm/leads.csv (stop `npm run dev` first)
```

## Next, in order

1. **Name the 29 prospects** in `gtm/prospects.csv`; book calls using the script in
   `gtm/README.md`.
2. **Deploy the landing page + API** so there's a link to send. Hosting not chosen yet
   (e.g. Vercel for the page, Fly/Railway for the API, Postgres in an AU region).
3. **Regulatory advice before Week 5 (pricing).** Triage software is very likely a medical
   device (TGA). Decides what can be charged for and when.
4. **Merge `feat/auth-persistence`** once reviewed.
5. Model, after a practice commits: adapt `research/Coherence_RealEngine_v3.ipynb` into a
   service (reuse `coherence/ml-service` skeleton), train on Colab or a rented GPU, validate
   per vendor. Keep the mock banner until PRD §10's conditions are met.

## Known gaps

- AHPRA is a **format** check only — no lookup against the public register.
- Practice isolation is app-level; PRD asks for Postgres **row-level security** too.
- Case IDs are random from ~11M combinations; a busy practice will eventually collide. The
  save fails cleanly with 409, but the real fix is a longer ID in `src/lib/deidentify.ts`.
- De-identification gaps from `README.md` still stand: multi-frame volumes, JPEG-2000,
  private tag groups, synthetic fixtures only.
- Landing-form rate limit trusts `x-forwarded-for`; fine for a waitlist, not strong.
- Thickness figure in the mock is a placeholder, not a measurement (`research/README.md`).

## Gotchas

- `.gitignore` was a merged Node + Python template. Its Python `lib/` rule silently hid
  `src/lib/`; now `/lib/`. Check with `git check-ignore -v <file>` if a new file doesn't show
  up in `git status`.
- PGlite allows one process at a time — stop the dev server before `npm run leads`.
- `notes/` is git-ignored and holds the exported Claude conversation from this session.
