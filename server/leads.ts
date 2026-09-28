/*
 * npm run leads - export landing-page sign-ups to gtm/leads.csv (git-ignored).
 * Reads the same database the API uses (DATABASE_URL, or .data/pglite).
 * Stop `npm run dev` first when using PGlite: it allows one process at a time.
 */
import { writeFileSync } from "node:fs";

import { desc } from "drizzle-orm";

try {
  process.loadEnvFile();
} catch {
  // no .env
}

const { openDb } = await import("./db");
const { interestSignups } = await import("./db/schema");

const { db, close } = await openDb();
const rows = await db.select().from(interestSignups).orderBy(desc(interestSignups.createdAt));
await close();

const cols = [
  "createdAt", "loi", "practiceName", "contactName", "email", "role", "state", "locations",
  "octVendor", "scansPerWeek", "priceBand", "pain", "source",
] as const;
const cell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n");
writeFileSync("gtm/leads.csv", csv + "\n");

const lois = rows.filter((r) => r.loi).length;
console.log(`${rows.length} sign-ups, ${lois} non-binding LOIs -> gtm/leads.csv`);
