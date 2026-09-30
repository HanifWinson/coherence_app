import { mkdirSync } from "node:fs";
import path from "node:path";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import * as schema from "./schema.js";

export { schema };
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

/**
 * `DATABASE_URL` set  -> real Postgres (production: an AU-region instance).
 * `DATABASE_URL` unset -> embedded PGlite on disk, so local dev needs no install.
 * `"memory"`           -> in-memory PGlite, for tests.
 *
 * Migrations run on open unless `migrate: false`. Serverless (Vercel) passes
 * false and runs `npm run db:migrate` at build time instead, so a cold start
 * never races another instance to migrate.
 *
 * Drivers are imported lazily so the Vercel bundle never pulls in PGlite's wasm.
 */
export async function openDb(
  opts: { url?: string; dataDir?: string; migrate?: boolean; poolMax?: number } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const url = opts.url ?? process.env.DATABASE_URL;
  const runMigrations = opts.migrate ?? true;

  if (url && url !== "memory") {
    const { default: pg } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.Pool({ connectionString: url, max: opts.poolMax });
    const db = drizzle(pool, { schema });
    if (runMigrations) {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db, { migrationsFolder: MIGRATIONS });
    }
    return { db: db as unknown as Db, close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  let client: InstanceType<typeof PGlite>;
  if (url === "memory") {
    client = new PGlite();
  } else {
    const dir = path.resolve(opts.dataDir ?? process.env.PGLITE_DIR ?? ".data/pglite");
    mkdirSync(path.dirname(dir), { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  if (runMigrations) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db, { migrationsFolder: MIGRATIONS });
  }
  return { db: db as unknown as Db, close: () => client.close() };
}
