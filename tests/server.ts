/*
 * API + database tests. Runs the real Hono app against in-memory Postgres
 * (PGlite) with the checked-in migrations - no network, no install.
 */
import { sql } from "drizzle-orm";

import { createApp } from "../server/app.js";
import { createAuth } from "../server/auth.js";
import { openDb } from "../server/db/index.js";

const ORIGIN = "http://coherence.test";
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  cond ? pass++ : fail++;
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const result = (decision: "cleared" | "rescan" | "review") => ({
  decision,
  uncertaintyShape: decision === "cleared" ? "low" : decision === "rescan" ? "diffuse" : "focal",
  confidence: decision === "cleared" ? 93 : 55,
  reason: "The model agrees with itself across all passes.",
  uTotal: null, topMass: null, blobShare: null,
  layerThicknessUm: 248, measurementUncertaintyUm: 14,
  heatmapUrl: PNG,
});
const scan = (caseId: string, decision: "cleared" | "rescan" | "review", extra = {}) => ({
  caseId, laterality: "OD", ageYears: 67, burnedInTextMasked: false, burnedInSource: null,
  strippedTagCount: 13, synthetic: false, result: result(decision), ...extra,
});

(async () => {
  const { db, close } = await openDb({ url: "memory" });
  const app = createApp({ db, auth: createAuth(db, { baseURL: ORIGIN, secret: "test-secret-".repeat(4) }) });

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    const res = await app.request(`${ORIGIN}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, res };
  };
  const signIn = async (email: string, password: string) => {
    const r = await call("POST", "/api/auth/sign-in/email", { email, password });
    const cookies = r.res.headers.getSetCookie().map((c) => c.split(";")[0]);
    return { status: r.status, cookie: cookies.join("; ") };
  };
  const PW = "correct-horse-battery";

  console.log("\n=== privacy: schema ===");
  const cols = await db.execute(sql`
    select table_name, column_name from information_schema.columns where table_schema = 'public'`);
  const colNames = (cols as unknown as { rows: Array<{ table_name: string; column_name: string }> }).rows
    .map((r) => `${r.table_name}.${r.column_name}`);
  const forbidden = colNames.filter((n) =>
    /patient|birth|dob|file_url|file_path|(^|\.)pixels?$|pixel_data$|scan_url/.test(n));
  check("no patient / DOB / file / pixel columns anywhere", forbidden.length === 0, forbidden.join(","));

  console.log("\n=== auth gating ===");
  check("public sign-up is closed",
    (await call("POST", "/api/auth/sign-up/email", { name: "x", email: "x@x.co", password: PW })).status === 403);
  check("API refuses anonymous requests", (await call("GET", "/api/me")).status === 401);

  const reg = await call("POST", "/api/register",
    { practiceName: "Westmead Eyecare", name: "Admin A", email: "admin@a.co", password: PW });
  check("register practice + admin", reg.status === 201, String(reg.status));
  check("register rejects a duplicate email", (await call("POST", "/api/register",
    { practiceName: "Dup", name: "Dup", email: "admin@a.co", password: PW })).status === 409);

  const adminA = await signIn("admin@a.co", PW);
  check("admin signs in", adminA.status === 200 && adminA.cookie.length > 0);
  const me = await call("GET", "/api/me", undefined, adminA.cookie);
  check("session carries role + practice", me.json?.user?.role === "admin" && me.json?.practice?.name === "Westmead Eyecare");
  check("admin cannot sign off", me.json?.canSignOff === false);

  console.log("\n=== members + AHPRA ===");
  const badAhpra = await call("POST", "/api/practice/members",
    { name: "Rev", email: "rev@a.co", password: PW, role: "reviewer", ahpraNumber: "OPT0012345" }, adminA.cookie);
  check("reviewer with malformed AHPRA rejected", badAhpra.status === 400);
  check("reviewer with valid AHPRA added", (await call("POST", "/api/practice/members",
    { name: "Rev A", email: "rev@a.co", password: PW, role: "reviewer", ahpraNumber: "opt0001234567" }, adminA.cookie)).status === 201);
  check("uploader added", (await call("POST", "/api/practice/members",
    { name: "Up A", email: "up@a.co", password: PW, role: "uploader" }, adminA.cookie)).status === 201);
  check("role cannot be escalated at invite", (await call("POST", "/api/practice/members",
    { name: "Evil", email: "evil@a.co", password: PW, role: "admin" }, adminA.cookie)).status === 400);

  const up = await signIn("up@a.co", PW);
  const rev = await signIn("rev@a.co", PW);
  check("uploader cannot manage members", (await call("POST", "/api/practice/members",
    { name: "X", email: "x@a.co", password: PW, role: "uploader" }, up.cookie)).status === 403);
  const revMe = await call("GET", "/api/me", undefined, rev.cookie);
  check("reviewer can sign off, AHPRA normalised", revMe.json?.canSignOff === true && revMe.json?.user?.ahpraNumber === "OPT0001234567");

  console.log("\n=== batches: only derived numbers accepted ===");
  const post = (cases: unknown[], cookie = up.cookie) =>
    call("POST", "/api/batches", { engineVersion: "mock-0.1", cases }, cookie);
  check("stray patientName field rejected", (await post([scan("CFG-2345", "cleared", { patientName: "SMITH^JOHN" })])).status === 400);
  check("pixel payload rejected",
    (await post([{ ...scan("CFG-2345", "cleared"), result: { ...result("cleared"), pixels: [1, 2, 3] } }])).status === 400);
  check("non-PNG heatmap rejected",
    (await post([{ ...scan("CFG-2345", "cleared"), result: { ...result("cleared"), heatmapUrl: "https://evil.example/x.png" } }])).status === 400);
  check("malformed case ID rejected", (await post([scan("WE-40182", "cleared")])).status === 400);

  const batch = await post([scan("CFG-2345", "cleared"), scan("HJK-6789", "review"), scan("MPQ-2233", "rescan")]);
  check("uploader saves a batch", batch.status === 201, String(batch.status));
  const reviewRef = batch.json?.cases?.find((c: { caseId: string }) => c.caseId === "HJK-6789")?.id;
  const clearedRef = batch.json?.cases?.find((c: { caseId: string }) => c.caseId === "CFG-2345")?.id;
  check("case ID reuse within a practice rejected", (await post([scan("CFG-2345", "cleared")])).status === 409);

  const list = await call("GET", "/api/batches", undefined, rev.cookie);
  const b0 = list.json?.batches?.[0];
  check("reviewer sees the practice's batch with counts",
    b0?.scanCount === 3 && b0?.clearedCount === 1 && b0?.reviewCount === 1 && b0?.rescanCount === 1);
  check("search by partial case ID", (await call("GET", "/api/batches?q=hjk", undefined, rev.cookie)).json?.batches?.length === 1);
  check("search miss returns nothing", (await call("GET", "/api/batches?q=ZZZ", undefined, rev.cookie)).json?.batches?.length === 0);

  console.log("\n=== sign-off gate ===");
  check("uploader cannot sign off",
    (await call("POST", `/api/cases/${reviewRef}/decisions`, { action: "agree" }, up.cookie)).status === 403);
  check("admin cannot sign off",
    (await call("POST", `/api/cases/${reviewRef}/decisions`, { action: "agree" }, adminA.cookie)).status === 403);
  check("disagree without an assessment rejected",
    (await call("POST", `/api/cases/${reviewRef}/decisions`, { action: "disagree" }, rev.cookie)).status === 400);
  check("reviewer agrees",
    (await call("POST", `/api/cases/${clearedRef}/decisions`, { action: "agree" }, rev.cookie)).status === 201);
  check("reviewer disagrees with reason",
    (await call("POST", `/api/cases/${reviewRef}/decisions`,
      { action: "disagree", clinicianAssessment: "cleared", reasonGiven: "drusen look benign" }, rev.cookie)).status === 201);

  const agreement = await call("GET", "/api/agreement", undefined, rev.cookie);
  check("monthly agreement rate", agreement.json?.pct === 50, JSON.stringify(agreement.json));

  const detail = await call("GET", `/api/batches/${batch.json?.batchId}`, undefined, rev.cookie);
  const disagreed = detail.json?.cases?.find((c: { caseId: string }) => c.caseId === "HJK-6789");
  check("reopened case keeps decision, assessment and heatmap",
    disagreed?.latestDecision?.action === "disagree" && disagreed?.latestDecision?.clinicianAssessment === "cleared"
      && disagreed?.latestDecision?.modelDecision === "review" && disagreed?.result?.heatmapUrl === PNG);
  check("reopened case records pixel data as deleted", disagreed?.pixelDataDeleted === true);

  console.log("\n=== audit log ===");
  await call("POST", "/api/audit", { action: "Case opened", caseRef: "HJK-6789" }, rev.cookie);
  const auditRes = await call("GET", "/api/audit", undefined, adminA.cookie);
  const actions: string[] = auditRes.json?.entries?.map((e: { action: string }) => e.action) ?? [];
  check("sign-ins are audited", actions.includes("Signed in"));
  check("batch save is audited", actions.some((a) => a.startsWith("Batch saved")));
  check("sign-off is audited by the server", actions.includes("Sign-off: disagree") && actions.includes("Sign-off: agree"));
  check("client events are audited", actions.includes("Case opened"));
  check("only admins read the audit log", (await call("GET", "/api/audit", undefined, rev.cookie)).status === 403);

  let updateBlocked = false, deleteBlocked = false;
  try { await db.execute(sql`update audit_log set action = 'tampered'`); } catch { updateBlocked = true; }
  try { await db.execute(sql`delete from audit_log`); } catch { deleteBlocked = true; }
  check("database refuses UPDATE on audit_log", updateBlocked);
  check("database refuses DELETE on audit_log", deleteBlocked);

  console.log("\n=== practice isolation ===");
  await call("POST", "/api/register", { practiceName: "Other Optical", name: "Admin B", email: "admin@b.co", password: PW });
  const adminB = await signIn("admin@b.co", PW);
  await call("POST", "/api/practice/members",
    { name: "Rev B", email: "rev@b.co", password: PW, role: "reviewer", ahpraNumber: "MED0009876543" }, adminB.cookie);
  const revB = await signIn("rev@b.co", PW);
  check("other practice sees no batches", (await call("GET", "/api/batches", undefined, revB.cookie)).json?.batches?.length === 0);
  check("other practice cannot open the batch",
    (await call("GET", `/api/batches/${batch.json?.batchId}`, undefined, revB.cookie)).status === 404);
  check("other practice cannot sign off the case",
    (await call("POST", `/api/cases/${reviewRef}/decisions`, { action: "agree" }, revB.cookie)).status === 404);
  const auditB: string[] = (await call("GET", "/api/audit", undefined, adminB.cookie)).json?.entries?.map((e: { action: string }) => e.action) ?? [];
  check("other practice's audit log is its own", !auditB.some((a) => a.startsWith("Batch saved")));
  check("same case ID is fine in another practice",
    (await post([scan("CFG-2345", "cleared")], revB.cookie)).status === 201);

  console.log("\n=== landing-page LOIs ===");
  const lead = {
    practiceName: "Harbourside Eyecare", contactName: "Sam Lee", email: "sam@harbourside.test",
    role: "practice_owner", state: "NSW", locations: 2, octVendor: "Spectralis",
    scansPerWeek: "25_100", priceBand: "100_300", loi: true, pain: "backlog on Mondays",
    source: "landing", consent: true,
  };
  check("LOI accepted without a session", (await call("POST", "/api/interest", lead)).status === 201);
  check("LOI without consent rejected", (await call("POST", "/api/interest", { ...lead, consent: false })).status === 400);
  check("honeypot-filled submission rejected", (await call("POST", "/api/interest", { ...lead, website: "spam.example" })).status === 400);
  check("unknown field rejected", (await call("POST", "/api/interest", { ...lead, patientName: "x" })).status === 400);
  const leads = await db.execute(sql`select practice_name, loi, price_band from interest_signups`);
  const leadRows = (leads as unknown as { rows: Array<{ practice_name: string; loi: boolean; price_band: string }> }).rows;
  check("LOI stored with price band", leadRows.length === 1 && leadRows[0].loi && leadRows[0].price_band === "100_300");
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    limited = (await call("POST", "/api/interest", lead)).status === 429;
  }
  check("public form is rate-limited", limited);

  console.log("\n=== registration switch (production default) ===");
  const closedApp = createApp({ db, auth: createAuth(db, { baseURL: ORIGIN, secret: "test-secret-".repeat(4) }), allowRegistration: false });
  const closedReg = await closedApp.request(`${ORIGIN}/api/register`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ practiceName: "Walk-in", name: "W", email: "w@walkin.co", password: PW }),
  });
  check("registration refused when closed", closedReg.status === 403);
  const cfg = await (await closedApp.request(`${ORIGIN}/api/config`)).json();
  check("config reports registration closed", cfg.registrationOpen === false);
  check("LOI form still open when registration is closed", (await closedApp.request(`${ORIGIN}/api/interest`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ ...lead, email: "other@practice.test" }),
  })).status === 201);

  await close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
