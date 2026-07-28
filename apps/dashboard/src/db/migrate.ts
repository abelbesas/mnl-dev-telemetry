import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { pgOptions } from "./connection";

/**
 * Apply generated migrations. Run: `pnpm db:migrate`.
 * Works against local Docker or a hosted DB (point DATABASE_URL at it) — for
 * Neon, use the DIRECT (non-pooled) connection string for DDL.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const sql = postgres(url, { ...pgOptions(url), max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: "./drizzle" });
  await sql.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
