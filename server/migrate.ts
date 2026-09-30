/*
 * npm run db:migrate - apply drizzle/ migrations to DATABASE_URL (or local PGlite).
 * Runs as part of the Vercel build, so deploys fail loudly on a bad migration
 * instead of the first request after a cold start.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env - fine on Vercel
}

export {};

const { openDb } = await import("./db/index.js");

if (process.env.VERCEL && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set for this Vercel environment - add the Postgres integration first");
}
const { close } = await openDb({ migrate: true });
await close();
console.log(`migrations applied · ${process.env.DATABASE_URL ? "Postgres" : "local PGlite"}`);
