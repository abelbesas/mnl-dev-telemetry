import type { DefaultSession } from "next-auth";

/**
 * Augment Auth.js types with the MnlDevTelemetry identity fields we stamp onto the
 * token/session in `auth.ts` (the DB user id and role).
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "dev" | "lead";
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: "dev" | "lead";
  }
}
