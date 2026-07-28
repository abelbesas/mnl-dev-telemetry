import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users, type UserRow } from "@/db/schema";

/**
 * Auth.js (NextAuth v5) configuration — the dashboard's human-facing auth
 * (spec §4.5 / §5). Google Workspace SSO is the production path; a
 * CREDENTIALS-based dev login is included *only* when DEV_LOGIN_ENABLED=true so
 * the demo never blocks on SSO-approval timing.
 *
 * We use the JWT session strategy (no database adapter): the `users` table is
 * the single source of identity, so on sign-in we upsert by email and stamp the
 * DB `id` + `role` onto the token. Aggregated (lead-only) views gate on `role`.
 */

const devLoginEnabled = process.env.DEV_LOGIN_ENABLED === "true";

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a signed-in identity to our `users` row, creating it as a `dev` on
 * first SSO sign-in. An existing user's `role` is never downgraded here.
 */
async function upsertUserByEmail(
  email: string,
  name: string | null | undefined,
): Promise<UserRow> {
  const db = getDb();
  const existing = await findUserByEmail(email);
  if (existing) {
    if (name && name !== existing.name) {
      await db.update(users).set({ name }).where(eq(users.id, existing.id));
      return { ...existing, name };
    }
    return existing;
  }
  const [row] = await db
    .insert(users)
    .values({ email, name: name ?? email, role: "dev" })
    .returning();
  return row!;
}

const providers: Provider[] = [];
// Google reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET from the env automatically;
// only register it when configured so the demo can run on dev login alone.
if (process.env.AUTH_GOOGLE_ID) providers.push(Google);
if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev-login",
      name: "Dev login",
      credentials: { email: { label: "Email", type: "email" } },
      authorize: async (creds) => {
        if (!devLoginEnabled) return null;
        const email = String(creds?.email ?? "")
          .trim()
          .toLowerCase();
        if (!email.includes("@")) return null;
        // Dev/demo convenience: provision the user (as a `dev`) on first
        // dev-login so onboarding a teammate for testing needs no pre-seeding.
        // Gated entirely by DEV_LOGIN_ENABLED — never reachable in production,
        // where Google SSO is the only sign-in.
        const user = await upsertUserByEmail(email, null);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    async jwt({ token, user }) {
      const email = user?.email ?? token.email;
      if (user && email) {
        const row = await upsertUserByEmail(email, user.name);
        token.userId = row.id;
        token.role = row.role;
        token.email = row.email;
        token.name = row.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.userId as string) ?? session.user.id;
        session.user.role = (token.role as "dev" | "lead") ?? "dev";
      }
      return session;
    },
  },
});

export const isDevLoginEnabled = devLoginEnabled;
export const isGoogleEnabled = Boolean(process.env.AUTH_GOOGLE_ID);
