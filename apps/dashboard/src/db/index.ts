import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pgOptions } from "./connection";
import * as schema from "./schema";

/**
 * Lazily-initialised Drizzle client. Lazy so that importing a route module (at
 * Next build time) doesn't require DATABASE_URL to be set — the connection is
 * only created on first query. A global cache avoids exhausting connections
 * across Next dev hot-reloads.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __mnlDevTelemetrySql?: ReturnType<typeof postgres>;
  __mnlDevTelemetryDb?: Db;
};

export function getDb(): Db {
  if (globalForDb.__mnlDevTelemetryDb) return globalForDb.__mnlDevTelemetryDb;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = globalForDb.__mnlDevTelemetrySql ?? postgres(url, pgOptions(url));
  const db = drizzle(sql, { schema, casing: "snake_case" });

  globalForDb.__mnlDevTelemetrySql = sql;
  globalForDb.__mnlDevTelemetryDb = db;
  return db;
}

export { schema };
