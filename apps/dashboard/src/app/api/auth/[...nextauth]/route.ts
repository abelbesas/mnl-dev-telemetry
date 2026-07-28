import { handlers } from "@/auth";

// Auth callbacks touch Postgres (user upsert), so pin the Node runtime.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
