/* Thin client for the Coherence API (server/). Same origin: Vite proxies /api
   in dev, so the Better Auth session cookie rides along automatically. */

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const issues = json?.issues && Object.entries(json.issues).map(([k, v]) => `${k}: ${v[0]}`).join("; ");
    throw new ApiError(res.status, issues || json?.error || json?.message || `Request failed (${res.status})`, json);
  }
  return json;
}

export const signIn = (email, password) =>
  api("/auth/sign-in/email", { method: "POST", body: { email, password } });
export const signOut = () => api("/auth/sign-out", { method: "POST", body: {} });
