import { mkdirSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";

import * as schema from "./schema";

export { schema };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

/**
 * `DATABASE_URL` set  -> real Postgres (production: an AU-region instance).
 * `DATABASE_URL` unset -> embedded PGlite on disk, so local dev needs no install.
 * `"memory"`           -> in-memory PGlite, for tests.
 *
 * Migrations run on open in every mode, so the schema can never drift from the
 * checked-in SQL in drizzle/.
 */
export async function openDb(
  opts: { url?: string; dataDir?: string } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = opts.url ?? process.env.DATABASE_URL;

  if (url && url !== "memory") {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzleNodePg(pool, { schema });
    await migrateNodePg(db, { migrationsFolder: MIGRATIONS });
    return { db: db as unknown as Db, close: () => pool.end() };
  }

  let client: PGlite;
  if (url === "memory") {
    client = new PGlite();
  } else {
    const dir = path.resolve(opts.dataDir ?? process.env.PGLITE_DIR ?? ".data/pglite");
    mkdirSync(path.dirname(dir), { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close() };
}
