import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { openDb } from "./db/index.js";

/**
 * Environment checks and wiring shared by the long-running server (index.ts)
 * and the Vercel function (api/[[...route]].ts).
 */
export async function buildApp(opts: { serverless?: boolean } = {}) {
  const production = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

  if (!process.env.BETTER_AUTH_SECRET) {
    if (production) throw new Error("BETTER_AUTH_SECRET must be set in production");
    console.warn("BETTER_AUTH_SECRET not set - using an insecure dev-only secret");
    process.env.BETTER_AUTH_SECRET = "coherence-dev-only-insecure-secret-do-not-deploy";
  }
  if (production && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set in production (Postgres, AU region)");
  }

  // Closed by default in production: the landing page is the public front
  // door, and practices are onboarded deliberately. Set to "true" to open it.
  const flag = process.env.ALLOW_PRACTICE_REGISTRATION;
  const allowRegistration = flag ? flag === "true" : !production;

  const { db } = await openDb(
    // One connection per function instance; use the provider's pooled URL.
    opts.serverless ? { migrate: false, poolMax: 1 } : {},
  );
  return createApp({ db, auth: createAuth(db), allowRegistration });
}
