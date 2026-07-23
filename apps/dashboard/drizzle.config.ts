import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Not needed for `generate`; only used by `drizzle-kit push`/`migrate`.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/devpulse",
  },
  casing: "snake_case",
});
