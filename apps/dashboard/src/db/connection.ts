import type postgres from "postgres";

/**
 * Postgres connection options shared by the app client (`db/index.ts`) and the
 * migrate/seed scripts, so local Docker and hosted Postgres (Neon / Vercel
 * Postgres / Supabase) behave correctly in both places.
 *
 * - Local (`localhost`): no TLS, a generous pool.
 * - Hosted: TLS required, and a small pool with `prepare: false` — the safe
 *   settings for serverless functions talking to a pooled endpoint (PgBouncer
 *   transaction mode), which is what Vercel + Neon give you.
 */

export function isLocalDb(url: string): boolean {
  return /(?:@|\/\/)(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(url);
}

export function pgOptions(url: string): postgres.Options<Record<string, never>> {
  const local = isLocalDb(url);
  const opts: postgres.Options<Record<string, never>> = {
    max: Number(process.env.DB_POOL_MAX ?? (local ? 10 : 3)),
  };
  if (!local) {
    opts.ssl = "require";
    opts.prepare = false;
  }
  return opts;
}
