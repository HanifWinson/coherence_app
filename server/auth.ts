import { randomUUID } from "node:crypto";

import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { Db } from "./db";
import { schema } from "./db";

/**
 * Better Auth, email + password. PRD §5: "do not build authentication".
 *
 * Public sign-up is closed: the HTTP sign-up route is blocked in app.ts, and
 * accounts are created only through /api/register (a new practice + its admin)
 * or by that admin inviting members. The role, practice and AHPRA fields are
 * `input: false`, so a client can never set them on itself.
 */
export function createAuth(db: Db, opts: { baseURL?: string; secret?: string } = {}) {
  const baseURL = opts.baseURL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:5173";
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
    secret: opts.secret ?? process.env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: [baseURL],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: false,
    },
    user: {
      additionalFields: {
        practiceId: { type: "string", required: false, input: false },
        role: { type: "string", required: false, defaultValue: "uploader", input: false },
        ahpraNumber: { type: "string", required: false, input: false },
        ahpraVerified: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 8, // one clinic day
      updateAge: 60 * 30,
    },
    databaseHooks: {
      session: {
        create: {
          // Sign-ins belong in the audit trail alongside clinical actions.
          after: async (session) => {
            const user = await db.query.users.findFirst({
              where: eq(schema.users.id, session.userId),
            });
            if (!user?.practiceId) return;
            await db.insert(schema.auditLog).values({
              id: randomUUID(),
              practiceId: user.practiceId,
              userId: user.id,
              role: user.role,
              caseRef: null,
              action: "Signed in",
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** AHPRA registration: profession prefix + 10 digits, e.g. OPT0001234567. */
export const AHPRA_PATTERN = /^(OPT|MED)\d{10}$/;
