# Coherence

Confidence-first AI triage for OCT retinal scans. Upload a batch, and it tells you which
scans a human actually needs to open.

**Triage aid. Not a diagnosis. All clinical decisions remain with the practitioner.**

## Run

```bash
npm install
cp .env.example .env     # optional in dev; set BETTER_AUTH_SECRET before deploying
npm run dev              # web on :5173, API on :8787 (Vite proxies /api)
```

No database to install: without `DATABASE_URL` the API uses embedded Postgres (PGlite) in
`.data/pglite`. Migrations in `drizzle/` run on start. Open http://localhost:5173 and
**Register a practice** — you become its admin, then add reviewers and uploaders under
*Members*.

## Deploy (Vercel)

`vercel.json` deploys the app, the landing page and the API together, with functions in
Sydney (`syd1`). `api/[[...route]].ts` runs the same Hono app as `server/index.ts`.

1. Import the GitHub repo into Vercel.
2. Add Postgres from the Vercel Marketplace (Neon), region **AWS Sydney (ap-southeast-2)**.
   It sets `DATABASE_URL`; use the pooled string.
3. Set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `BETTER_AUTH_URL` (the
   production URL).
4. Deploy. The build runs `npm run db:migrate` first, so a bad migration fails the deploy.

URLs: `/` the app (sign-in) · `/landing` the pilot page · `/api/*` the API.

Practice registration is **closed in production** unless `ALLOW_PRACTICE_REGISTRATION=true`.
To create the first practice, set it to `true`, register, then remove it and redeploy.

Serverless caveat: the landing form's rate limit is per function instance, so it is weaker
on Vercel than locally.

## The three outcomes

Triage is by the **spatial shape** of the model's own uncertainty, not by what it detected.

| Decision | Trigger | Next step |
|---|---|---|
| **Cleared** | high confidence, uncertainty only at layer boundaries | no review, recall in 12 months |
| **Rescan** | uncertainty spread evenly across the image | capture problem — retake while the patient is seated |
| **Review** | uncertainty concentrated in one region | capture is fine, anatomy is ambiguous — a rescan won't help |

## Status

| Part | State |
|---|---|
| Upload → triage → report → review | built |
| **Client-side DICOM de-identification** | **built and tested** (`src/lib/deidentify.ts`) |
| Accessibility (blue/orange, icon + label, greyscale-legible) | built |
| Auth (Better Auth), practices, invite-only members | built — sign-up only via practice registration |
| Roles / AHPRA sign-off gate | enforced server-side — reviewer + AHPRA **format** check; register lookup not built |
| Persistence (Postgres / PGlite, Drizzle) | built — derived numbers + heatmaps only; schema has no patient/pixel columns |
| Disagree capture | built, persisted (`decisions` table) |
| Audit log | persisted, append-only (DB trigger rejects UPDATE/DELETE) |
| History — search by case ID / date, reopen | built |
| Auto-lock | 5 min idle; unlock needs the password |
| Practice isolation | app-level scoping in every query; Postgres RLS **not yet** |
| Triage engine | **MockEngine** — canned results, no model |
| Deploy | not started |

`RealEngine` is stubbed. Keep `ENGINE_ENV = "mock"` and the mock banner visible until a
model has been validated across vendors.

## De-identification

The one part that is real rather than simulated. Runs entirely in the browser, before
anything is uploaded — the practice keeps the patient mapping and we never receive it.

Strips the eleven identifying DICOM tags plus nine more outside the keep-list, converts
DOB to age then deletes it, drops exact study timestamps, and replaces `PatientID` with a
random case ID generated client-side.

For burned-in patient names it checks `BurnedInAnnotation` (0028,0301) **and** examines
the pixels independently, because that tag is often absent or wrong. Masked pixels are
written back into the output file.

`dcmjs` is loaded lazily on first file, so it stays out of the initial bundle.

### Tests

```bash
npm run test:fixtures    # build DICOM fixtures (needs python3 + pydicom)
npm run test             # 48 assertions + false-positive suite + 43 API/DB checks
```

Expected: `48 passed, 0 failed` and `0/60 false positives, 30/30 recall`.

The strongest assertion re-parses the **output** file and scans its raw bytes for the
original patient name, institution, device serial and phone number. None survive.

### Known limitations

- Fixtures are synthetic. The 0% false-positive rate is a property of those fixtures, not
  of real vendor exports. **Test against real Spectralis and Cirrus files before a pilot.**
- Single-frame, uncompressed only. Multi-frame volumes and JPEG-2000 are common in
  ophthalmic DICOM and are not handled.
- Band masking is blunt — it blanks the top and bottom 12%. If a vendor renders text over
  the retina this both misses it and damages the image.
- Private tag groups are not audited. Production should strip them by default.
- De-identification reduces risk; it does not make data non-personal under the Privacy Act.

## Model status

`RealEngine` is not wired up, but the model work exists and has numbers. See
[`research/README.md`](research/README.md) for the full record.

Short version: a model trained on normal anatomy only separates real CNV from normal at
**AUC 0.76** [0.69–0.82] and DME at **0.69** [0.62–0.77], with early drusen **at chance**.
Capture-failure detection is the better-supported half — `u_total` rises in 21/25 degraded
scans (p=0.0016).

Single dataset, single vendor, internal validation. Not clinical evidence.

## Layout

```
src/App.jsx            all screens + styling
src/lib/deidentify.ts  client-side DICOM de-identification
src/lib/api.js         fetch wrapper for the API
server/                Hono API: auth, batches, decisions, audit, history
server/db/schema.ts    PRD §8 schema - read the comments on what is absent
drizzle/               SQL migrations (incl. the append-only audit trigger)
tests/test.ts          correctness assertions
tests/fp.ts            false-positive / recall rates
tests/server.ts        API + DB: auth gating, privacy, sign-off gate, isolation
tests/make_fixtures.py generates DICOM fixtures with real identifying tags
research/              the model: notebook, analysis cells, and what the numbers mean
```

## For anyone picking this up

1. `research/README.md` — what was tried, what broke, what the numbers support
2. `src/lib/deidentify.ts` — the only part that is real rather than simulated
3. The status table above — believe it, it is accurate
