/*
 * Vercel function. vercel.json rewrites every /api/* path here - Vercel's
 * file-based catch-alls only match one segment outside Next.js - and the
 * request keeps its original URL, so Hono routes it exactly as the local
 * server does. Built once per function instance.
 */
import { buildApp } from "../server/runtime.js";

const app = await buildApp({ serverless: true });
const handle = (req: Request) => app.fetch(req);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
