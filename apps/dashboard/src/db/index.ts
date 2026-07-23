import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Lazily-initialised Drizzle client. Lazy so that importing a route module (at
 * Next build time) doesn't require DATABASE_URL to be set — the connection is
 * only created on first query. A global cache avoids exhausting connections
 * across Next dev hot-reloads.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __devpulseSql?: ReturnType<typeof postgres>;
  __devpulseDb?: Db;
};

export function getDb(): Db {
  if (globalForDb.__devpulseDb) return globalForDb.__devpulseDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = globalForDb.__devpulseSql ?? postgres(url, { max: 10 });
  const db = drizzle(sql, { schema, casing: "snake_case" });

  globalForDb.__devpulseSql = sql;
  globalForDb.__devpulseDb = db;
  return db;
}

export { schema };
