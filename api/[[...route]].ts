/*
 * Vercel function: every /api/* request lands here and goes to the same Hono
 * app the local server runs. Built once per function instance.
 */
import { buildApp } from "../server/runtime";

const app = await buildApp({ serverless: true });
const handle = (req: Request) => app.fetch(req);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
