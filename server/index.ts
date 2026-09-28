import { serve } from "@hono/node-server";

try {
  process.loadEnvFile();
} catch {
  // no .env - fine in production, where the platform injects env vars
}

const { createApp } = await import("./app");
const { createAuth } = await import("./auth");
const { openDb } = await import("./db");

if (!process.env.BETTER_AUTH_SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET must be set in production");
  }
  console.warn("BETTER_AUTH_SECRET not set - using an insecure dev-only secret");
  process.env.BETTER_AUTH_SECRET = "coherence-dev-only-insecure-secret-do-not-deploy";
}
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set in production (Postgres, AU region)");
}

const { db } = await openDb();
const app = createApp({ db, auth: createAuth(db) });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  const store = process.env.DATABASE_URL ? "Postgres" : "embedded PGlite (.data/pglite)";
  console.log(`coherence api on http://localhost:${port} · ${store}`);
});
