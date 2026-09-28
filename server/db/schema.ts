import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * PRD §8. The schema is where the privacy commitment becomes real, so note what
 * is ABSENT: no patient name, no patient identifier, no date of birth, no file
 * URL, no pixel data. tests/server.ts asserts these columns never appear.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`);
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`);

export const ROLES = ["uploader", "reviewer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const DECISIONS = ["cleared", "rescan", "review"] as const;
export const SHAPES = ["low", "focal", "diffuse"] as const;
export const ACTIONS = ["agree", "disagree", "request_rescan", "refer"] as const;
export const ASSESSMENTS = ["cleared", "review", "rescan", "refer"] as const;

/* ------------------------------------------------------------------ */
/*  Practices                                                         */
/* ------------------------------------------------------------------ */

export const practices = pgTable("practices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Data residency. PRD §2: Australian region. */
  region: text("region").notNull().default("au"),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/*  Auth tables - Better Auth core schema plus practice/role/AHPRA     */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    practiceId: text("practice_id").references(() => practices.id),
    role: text("role", { enum: ROLES }).notNull().default("uploader"),
    /** OPT… / MED… registration. Only reviewers carry one. */
    ahpraNumber: text("ahpra_number"),
    ahpraVerified: boolean("ahpra_verified").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_practice_idx").on(t.practiceId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.token),
    index("sessions_user_idx").on(t.userId),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/*  Domain                                                            */
/* ------------------------------------------------------------------ */

export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(),
    practiceId: text("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    scanCount: integer("scan_count").notNull(),
    clearedCount: integer("cleared_count").notNull(),
    rescanCount: integer("rescan_count").notNull(),
    reviewCount: integer("review_count").notNull(),
    engineVersion: text("engine_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("batches_practice_created_idx").on(t.practiceId, t.createdAt)],
);

export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    /** Denormalised from the batch so every query can scope by practice. */
    practiceId: text("practice_id")
      .notNull()
      .references(() => practices.id),
    /** Random pseudonym generated in the browser. The practice keeps the mapping. */
    caseId: text("case_id").notNull(),
    laterality: text("laterality"),
    /** Replaces date of birth, which is never received. */
    ageYears: integer("age_years"),
    burnedInTextMasked: boolean("burned_in_text_masked").notNull().default(false),
    /** "tag" | "pixels" | null - which check found the burned-in text. */
    burnedInSource: text("burned_in_source"),
    strippedTagCount: integer("stripped_tag_count").notNull().default(0),
    /** Always true: the server never receives pixels. Enforced by a CHECK. */
    pixelDataDeleted: boolean("pixel_data_deleted").notNull().default(true),
    /** Demo sample batch - never real de-identified data. */
    synthetic: boolean("synthetic").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("cases_practice_case_idx").on(t.practiceId, t.caseId),
    index("cases_batch_idx").on(t.batchId),
  ],
);

export const triageResults = pgTable(
  "triage_results",
  {
    id: text("id").primaryKey(),
    caseRef: text("case_ref")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    decision: text("decision", { enum: DECISIONS }).notNull(),
    uncertaintyShape: text("uncertainty_shape", { enum: SHAPES }).notNull(),
    confidence: integer("confidence").notNull(),
    reason: text("reason").notNull(),
    /*
     * The three shape statistics. Kept so a later threshold change can be
     * re-evaluated against past cases. Null for MockEngine, which has none.
     */
    uTotal: real("u_total"),
    topMass: real("top_mass"),
    blobShare: real("blob_share"),
    layerThicknessUm: integer("layer_thickness_um").notNull(),
    measurementUncertaintyUm: integer("measurement_uncertainty_um").notNull(),
    /** The uncertainty heatmap only - never the scan itself. */
    heatmapUrl: text("heatmap_url").notNull(),
    engineVersion: text("engine_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("triage_results_case_idx").on(t.caseRef)],
);

/** The calibration dataset (PRD §4, phase 5). */
export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    caseRef: text("case_ref")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    action: text("action", { enum: ACTIONS }).notNull(),
    /** What the model said, frozen at the time of the decision. */
    modelDecision: text("model_decision", { enum: DECISIONS }).notNull(),
    /** What the clinician said the answer was. Required for a disagreement. */
    clinicianAssessment: text("clinician_assessment", { enum: ASSESSMENTS }),
    reasonGiven: text("reason_given"),
    createdAt: createdAt(),
  },
  (t) => [
    index("decisions_case_idx").on(t.caseRef),
    index("decisions_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Append-only. There is no update or delete path in the API, and a trigger in
 * the migrations rejects UPDATE and DELETE at the database level too.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    practiceId: text("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    /** The case pseudonym, or null for batch/session-level events. */
    caseRef: text("case_ref"),
    action: text("action").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_practice_created_idx").on(t.practiceId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/*  Relations                                                         */
/* ------------------------------------------------------------------ */

export const practicesRelations = relations(practices, ({ many }) => ({
  users: many(users),
  batches: many(batches),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  practice: one(practices, { fields: [users.practiceId], references: [practices.id] }),
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const batchesRelations = relations(batches, ({ one, many }) => ({
  practice: one(practices, { fields: [batches.practiceId], references: [practices.id] }),
  user: one(users, { fields: [batches.userId], references: [users.id] }),
  cases: many(cases),
}));

export const casesRelations = relations(cases, ({ one, many }) => ({
  batch: one(batches, { fields: [cases.batchId], references: [batches.id] }),
  result: one(triageResults, { fields: [cases.id], references: [triageResults.caseRef] }),
  decisions: many(decisions),
}));

export const triageResultsRelations = relations(triageResults, ({ one }) => ({
  case: one(cases, { fields: [triageResults.caseRef], references: [cases.id] }),
}));

export const decisionsRelations = relations(decisions, ({ one }) => ({
  case: one(cases, { fields: [decisions.caseRef], references: [cases.id] }),
  user: one(users, { fields: [decisions.userId], references: [users.id] }),
}));
