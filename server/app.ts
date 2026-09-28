import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { AHPRA_PATTERN, type Auth } from "./auth";
import type { Db } from "./db";
import {
  ACTIONS,
  ASSESSMENTS,
  DECISIONS,
  SHAPES,
  auditLog,
  batches,
  cases,
  decisions,
  practices,
  triageResults,
  users,
  type Role,
} from "./db/schema";

type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  practiceId: string;
  ahpraNumber: string | null;
  ahpraVerified: boolean;
};

type Env = { Variables: { user: SessionUser } };

/** Client-generated pseudonym, e.g. CYW-6337. Anything else is rejected. */
const CASE_ID = z.string().regex(/^[A-Z]{3}-\d{4}$/);
const HEATMAP = z
  .string()
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
  .max(3_000_000);

/*
 * Strict schemas: an unknown key is a 400, not silently dropped. That is the
 * point - a stray `patientName` or `pixels` field must fail loudly, never be
 * accepted and ignored.
 */
const batchBody = z.strictObject({
  engineVersion: z.string().min(1).max(64),
  cases: z
    .array(
      z.strictObject({
        caseId: CASE_ID,
        laterality: z.enum(["OD", "OS"]).nullable(),
        ageYears: z.number().int().min(0).max(130).nullable(),
        burnedInTextMasked: z.boolean(),
        burnedInSource: z.enum(["tag", "pixels"]).nullable(),
        strippedTagCount: z.number().int().min(0).max(500),
        synthetic: z.boolean(),
        result: z.strictObject({
          decision: z.enum(DECISIONS),
          uncertaintyShape: z.enum(SHAPES),
          confidence: z.number().int().min(0).max(100),
          reason: z.string().min(1).max(500),
          uTotal: z.number().nullable(),
          topMass: z.number().nullable(),
          blobShare: z.number().nullable(),
          layerThicknessUm: z.number().int().min(0).max(2000),
          measurementUncertaintyUm: z.number().int().min(0).max(1000),
          heatmapUrl: HEATMAP,
        }),
      }),
    )
    .min(1)
    .max(500),
});

const decisionBody = z
  .strictObject({
    action: z.enum(ACTIONS),
    clinicianAssessment: z.enum(ASSESSMENTS).nullable().optional(),
    reasonGiven: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => b.action !== "disagree" || !!b.clinicianAssessment, {
    message: "A disagreement must say what the clinician's assessment was",
    path: ["clinicianAssessment"],
  });

const registerBody = z.strictObject({
  practiceName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  password: z.string().min(10).max(128),
});

const memberBody = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    email: z.email(),
    password: z.string().min(10).max(128),
    role: z.enum(["uploader", "reviewer"]),
    ahpraNumber: z.string().trim().toUpperCase().nullable().optional(),
  })
  .refine((b) => b.role !== "reviewer" || AHPRA_PATTERN.test(b.ahpraNumber ?? ""), {
    message: "A reviewer needs an AHPRA registration: OPT or MED followed by 10 digits",
    path: ["ahpraNumber"],
  });

const auditBody = z.strictObject({
  action: z.string().trim().min(1).max(300),
  caseRef: CASE_ID.nullable().optional(),
});

function bad(c: Context, error: z.ZodError) {
  return c.json({ error: "Invalid request", issues: z.flattenError(error).fieldErrors }, 400);
}

export function createApp({ db, auth }: { db: Db; auth: Auth }) {
  const app = new Hono<Env>().basePath("/api");

  const audit = (
    tx: Pick<Db, "insert">,
    user: Pick<SessionUser, "id" | "practiceId" | "role">,
    action: string,
    caseRef: string | null = null,
  ) =>
    tx.insert(auditLog).values({
      id: randomUUID(),
      practiceId: user.practiceId,
      userId: user.id,
      role: user.role,
      caseRef,
      action,
    });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  /* ---------------- auth ---------------- */

  // Sign-up is by practice registration or admin invite only.
  app.all("/auth/sign-up/*", (c) => c.json({ error: "Sign-up is by invitation" }, 403));
  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

  /** A new practice and its admin account. The only public account creation. */
  app.post("/register", async (c) => {
    const parsed = registerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error);
    const { practiceName, name, email, password } = parsed.data;

    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) return c.json({ error: "An account with that email already exists" }, 409);

    const { user } = await auth.api.signUpEmail({ body: { name, email, password } });
    const practiceId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(practices).values({ id: practiceId, name: practiceName });
      await tx
        .update(users)
        .set({ practiceId, role: "admin", updatedAt: new Date() })
        .where(eq(users.id, user.id));
      await audit(tx, { id: user.id, practiceId, role: "admin" }, "Practice registered");
    });
    return c.json({ ok: true }, 201);
  });

  /* ---------------- everything below needs a session ---------------- */

  app.use("*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const u = session?.user as (Partial<SessionUser> & { id: string }) | undefined;
    if (!u) return c.json({ error: "Not signed in" }, 401);
    if (!u.practiceId) return c.json({ error: "Account is not attached to a practice" }, 403);
    c.set("user", {
      id: u.id,
      name: u.name ?? "",
      email: u.email ?? "",
      role: (u.role ?? "uploader") as Role,
      practiceId: u.practiceId,
      ahpraNumber: u.ahpraNumber ?? null,
      ahpraVerified: !!u.ahpraVerified,
    });
    await next();
  });

  const requireRole = (c: Context<Env>, ...roles: Role[]) =>
    roles.includes(c.get("user").role)
      ? null
      : c.json({ error: `Requires role: ${roles.join(" or ")}` }, 403);

  app.get("/me", async (c) => {
    const user = c.get("user");
    const practice = await db.query.practices.findFirst({
      where: eq(practices.id, user.practiceId),
    });
    return c.json({
      user,
      practice: practice && { id: practice.id, name: practice.name, region: practice.region },
      canSignOff: user.role === "reviewer" && user.ahpraVerified,
    });
  });

  /* ---------------- practice members (admin) ---------------- */

  app.get("/practice/members", async (c) => {
    const denied = requireRole(c, "admin");
    if (denied) return denied;
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        ahpraNumber: users.ahpraNumber,
        ahpraVerified: users.ahpraVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.practiceId, c.get("user").practiceId))
      .orderBy(users.createdAt);
    return c.json({ members: rows });
  });

  app.post("/practice/members", async (c) => {
    const denied = requireRole(c, "admin");
    if (denied) return denied;
    const parsed = memberBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error);
    const { name, email, password, role, ahpraNumber } = parsed.data;
    const admin = c.get("user");

    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) return c.json({ error: "An account with that email already exists" }, 409);

    const { user } = await auth.api.signUpEmail({ body: { name, email, password } });
    const isReviewer = role === "reviewer";
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          practiceId: admin.practiceId,
          role,
          ahpraNumber: isReviewer ? ahpraNumber! : null,
          // Format check only. A lookup against the public AHPRA register is
          // still to be built - see README.
          ahpraVerified: isReviewer,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await audit(tx, admin, `Member added · ${email} · ${role}`);
    });
    return c.json({ ok: true, id: user.id }, 201);
  });

  /* ---------------- batches ---------------- */

  app.post("/batches", bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
    const parsed = batchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error);
    const { engineVersion, cases: incoming } = parsed.data;
    const user = c.get("user");

    const ids = incoming.map((x) => x.caseId);
    if (new Set(ids).size !== ids.length) {
      return c.json({ error: "Duplicate case ID within the batch" }, 400);
    }
    const clash = await db
      .select({ caseId: cases.caseId })
      .from(cases)
      .where(and(eq(cases.practiceId, user.practiceId), inArray(cases.caseId, ids)));
    if (clash.length) {
      return c.json({ error: "Case ID already used", caseIds: clash.map((r) => r.caseId) }, 409);
    }

    const count = (d: (typeof DECISIONS)[number]) =>
      incoming.filter((x) => x.result.decision === d).length;
    const batchId = randomUUID();
    const saved: Array<{ caseId: string; id: string }> = [];

    await db.transaction(async (tx) => {
      await tx.insert(batches).values({
        id: batchId,
        practiceId: user.practiceId,
        userId: user.id,
        scanCount: incoming.length,
        clearedCount: count("cleared"),
        rescanCount: count("rescan"),
        reviewCount: count("review"),
        engineVersion,
      });
      for (const x of incoming) {
        const id = randomUUID();
        saved.push({ caseId: x.caseId, id });
        await tx.insert(cases).values({
          id,
          batchId,
          practiceId: user.practiceId,
          caseId: x.caseId,
          laterality: x.laterality,
          ageYears: x.ageYears,
          burnedInTextMasked: x.burnedInTextMasked,
          burnedInSource: x.burnedInSource,
          strippedTagCount: x.strippedTagCount,
          pixelDataDeleted: true,
          synthetic: x.synthetic,
        });
        await tx.insert(triageResults).values({
          id: randomUUID(),
          caseRef: id,
          ...x.result,
          engineVersion,
        });
      }
      await audit(
        tx,
        user,
        `Batch saved · ${incoming.length} scans · engine=${engineVersion} · derived numbers only`,
      );
    });

    return c.json({ batchId, cases: saved }, 201);
  });

  /** Uploaders see their own batches; reviewers and admins see the practice's. */
  const batchScope = (user: SessionUser) =>
    user.role === "uploader"
      ? and(eq(batches.practiceId, user.practiceId), eq(batches.userId, user.id))
      : eq(batches.practiceId, user.practiceId);

  app.get("/batches", async (c) => {
    const user = c.get("user");
    const q = c.req.query("q")?.trim().toUpperCase();
    const from = c.req.query("from");
    const to = c.req.query("to");

    const where = [batchScope(user)];
    if (from && !Number.isNaN(Date.parse(from))) where.push(gte(batches.createdAt, new Date(from)));
    if (to && !Number.isNaN(Date.parse(to))) {
      where.push(lte(batches.createdAt, new Date(`${to.slice(0, 10)}T23:59:59.999Z`)));
    }
    if (q) {
      const matching = db
        .select({ id: cases.batchId })
        .from(cases)
        .where(and(eq(cases.practiceId, user.practiceId), ilike(cases.caseId, `%${q}%`)));
      where.push(inArray(batches.id, matching));
    }

    const rows = await db
      .select({
        id: batches.id,
        createdAt: batches.createdAt,
        scanCount: batches.scanCount,
        clearedCount: batches.clearedCount,
        rescanCount: batches.rescanCount,
        reviewCount: batches.reviewCount,
        engineVersion: batches.engineVersion,
        uploadedBy: users.name,
        synthetic: sql<boolean>`exists (select 1 from ${cases} where ${cases.batchId} = ${batches.id} and ${cases.synthetic})`,
        signedCount: sql<number>`(select count(distinct ${decisions.caseRef})::int from ${decisions} join ${cases} on ${cases.id} = ${decisions.caseRef} where ${cases.batchId} = ${batches.id})`,
      })
      .from(batches)
      .innerJoin(users, eq(users.id, batches.userId))
      .where(and(...where))
      .orderBy(desc(batches.createdAt))
      .limit(100);
    return c.json({ batches: rows });
  });

  app.get("/batches/:id", async (c) => {
    const user = c.get("user");
    const [batch] = await db
      .select()
      .from(batches)
      .where(and(eq(batches.id, c.req.param("id")), batchScope(user)))
      .limit(1);
    if (!batch) return c.json({ error: "Not found" }, 404);

    const rows = await db
      .select({ case: cases, result: triageResults })
      .from(cases)
      .innerJoin(triageResults, eq(triageResults.caseRef, cases.id))
      .where(eq(cases.batchId, batch.id));

    const caseRefs = rows.map((r) => r.case.id);
    const decisionRows = caseRefs.length
      ? await db
          .select({ d: decisions, by: users.name })
          .from(decisions)
          .innerJoin(users, eq(users.id, decisions.userId))
          .where(inArray(decisions.caseRef, caseRefs))
          .orderBy(desc(decisions.createdAt))
      : [];
    const latest = new Map<string, (typeof decisionRows)[number]>();
    for (const row of decisionRows) if (!latest.has(row.d.caseRef)) latest.set(row.d.caseRef, row);

    return c.json({
      batch,
      cases: rows.map(({ case: k, result }) => {
        const d = latest.get(k.id);
        return {
          ...k,
          result,
          latestDecision: d && { ...d.d, by: d.by },
        };
      }),
    });
  });

  /* ---------------- clinical decisions ---------------- */

  app.post("/cases/:id/decisions", async (c) => {
    const user = c.get("user");
    // PRD §5: gate sign-off, not upload.
    if (user.role !== "reviewer" || !user.ahpraVerified) {
      return c.json({ error: "Sign-off requires a reviewer with a verified AHPRA registration" }, 403);
    }
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error);
    const body = parsed.data;

    const [row] = await db
      .select({ case: cases, decision: triageResults.decision })
      .from(cases)
      .innerJoin(triageResults, eq(triageResults.caseRef, cases.id))
      .where(and(eq(cases.id, c.req.param("id")), eq(cases.practiceId, user.practiceId)))
      .limit(1);
    if (!row) return c.json({ error: "Not found" }, 404);

    const id = randomUUID();
    const createdAt = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(decisions).values({
        id,
        caseRef: row.case.id,
        userId: user.id,
        action: body.action,
        modelDecision: row.decision,
        clinicianAssessment: body.action === "disagree" ? body.clinicianAssessment! : null,
        reasonGiven: body.reasonGiven?.trim() || null,
        createdAt,
      });
      await audit(tx, user, `Sign-off: ${body.action.replace("_", " ")}`, row.case.caseId);
    });
    return c.json({ id, action: body.action, createdAt }, 201);
  });

  /** The clinician's own agreement rate this calendar month (PRD §4, phase 3). */
  app.get("/agreement", async (c) => {
    const user = c.get("user");
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [r] = await db
      .select({
        agreed: sql<number>`count(*) filter (where ${decisions.action} = 'agree')::int`,
        decided: sql<number>`count(*) filter (where ${decisions.action} in ('agree','disagree'))::int`,
      })
      .from(decisions)
      .where(and(eq(decisions.userId, user.id), gte(decisions.createdAt, monthStart)));
    return c.json({
      agreed: r.agreed,
      decided: r.decided,
      pct: r.decided ? Math.round((100 * r.agreed) / r.decided) : null,
    });
  });

  /* ---------------- audit log (append-only) ---------------- */

  app.post("/audit", async (c) => {
    const parsed = auditBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return bad(c, parsed.error);
    await audit(db, c.get("user"), parsed.data.action, parsed.data.caseRef ?? null);
    return c.json({ ok: true }, 201);
  });

  app.get("/audit", async (c) => {
    const denied = requireRole(c, "admin");
    if (denied) return denied;
    const rows = await db
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        role: auditLog.role,
        caseRef: auditLog.caseRef,
        action: auditLog.action,
        user: users.name,
      })
      .from(auditLog)
      .innerJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.practiceId, c.get("user").practiceId))
      .orderBy(desc(auditLog.createdAt))
      .limit(500);
    return c.json({ entries: rows });
  });

  return app;
}
