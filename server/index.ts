import { serve } from "@hono/node-server";

try {
  process.loadEnvFile();
} catch {
  // no .env - fine in production, where the platform injects env vars
}

const { buildApp } = await import("./runtime.js");

const app = await buildApp();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  const store = process.env.DATABASE_URL ? "Postgres" : "embedded PGlite (.data/pglite)";
  console.log(`coherence api on http://localhost:${port} · ${store}`);
});
