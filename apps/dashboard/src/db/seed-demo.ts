import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  stitchUserEvents,
  type StitchEvent,
  type WorkingHours,
} from "../lib/stitch";
import { pgOptions } from "./connection";
import * as schema from "./schema";

/**
 * DEV-ONLY demo seed. Generates a realistic mixed dataset — 3 devs + 1 lead, a
 * couple of weeks of events across several tickets, some AI-assisted — so the
 * timeline and (especially) the team view have a story to show without waiting
 * for real machines to report. Refuses to run against a production build.
 *
 * The event stream is fully deterministic (seeded PRNG), so re-running produces
 * the same dataset. The stitching that turns those events into sessions is the
 * REAL, tested `stitchUserEvents`; only the per-ticket *estimates* are
 * synthesised (from each ticket's stitched actual) so the estimate-vs-actual and
 * AI-cohort charts read clearly in a demo.
 *
 * Run: `pnpm db:seed:demo`
 */

// --- Guard ----------------------------------------------------------------

if (process.env.NODE_ENV === "production" && process.env.DEMO_SEED_FORCE !== "1") {
  console.error(
    "Refusing to run the demo seed with NODE_ENV=production. Set DEMO_SEED_FORCE=1 to override.",
  );
  process.exit(1);
}

// --- Deterministic RNG ----------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xde4901);
const rand = (lo: number, hi: number) => lo + rng() * (hi - lo);
const randInt = (lo: number, hi: number) => Math.floor(rand(lo, hi + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

function uuid(): string {
  const b = [...Array(16)].map(() => Math.floor(rng() * 256));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

// --- Demo definition ------------------------------------------------------

const MANILA: WorkingHours = {
  tz: "Asia/Manila",
  workdayStart: "09:00",
  workdayEnd: "18:00",
};

const REPOS: Record<string, string> = {
  WEB: "web-app",
  API: "api-service",
  PLAT: "platform",
};
const repoFor = (issueKey: string) => REPOS[issueKey.split("-")[0]!] ?? "misc";

interface DemoUser {
  email: string;
  name: string;
  role: "dev" | "lead";
  tickets: string[];
  /** Probability any given work block uses an AI agent. */
  aiBias: number;
}

const DEMO_USERS: DemoUser[] = [
  {
    email: "alice@devpulse.local",
    name: "Alice Reyes",
    role: "dev",
    tickets: ["WEB-101", "WEB-102", "WEB-103"],
    aiBias: 0.85,
  },
  {
    email: "bob@devpulse.local",
    name: "Bob Santos",
    role: "dev",
    tickets: ["WEB-104", "API-201", "API-202"],
    aiBias: 0.5,
  },
  {
    email: "carol@devpulse.local",
    name: "Carol Cruz",
    role: "dev",
    tickets: ["API-203", "API-204", "PLAT-301"],
    aiBias: 0.15,
  },
  {
    email: "dana@devpulse.local",
    name: "Dana Lim",
    role: "lead",
    tickets: ["PLAT-302", "PLAT-301"],
    aiBias: 0.4,
  },
];

const DAYS_BACK = 18; // ~2.5 working weeks so the trend chart has multiple points
const AI_CO_AUTHOR = "Claude <noreply@anthropic.com>";
const MCP_TOOLS = ["log_context", "get_my_tasks", "task_start"] as const;

type NewEvent = typeof schema.events.$inferInsert;

/** Build a Manila-local wall time on a given date as a UTC instant (UTC+8). */
function manilaInstant(y: number, mo: number, d: number, hoursFloat: number): Date {
  const h = Math.floor(hoursFloat);
  const min = Math.floor((hoursFloat - h) * 60);
  return new Date(Date.UTC(y, mo, d, h - 8, min));
}

// --- Generation -----------------------------------------------------------

function generateForUser(userId: string, u: DemoUser, nowMs: number): NewEvent[] {
  const events: NewEvent[] = [];
  // "Today" in Manila (UTC+8) as UTC date components.
  const manilaNow = new Date(nowMs + 8 * 3600_000);
  const y = manilaNow.getUTCFullYear();
  const mo = manilaNow.getUTCMonth();
  const dom = manilaNow.getUTCDate();

  let ticketIdx = 0;

  for (let back = DAYS_BACK; back >= 0; back--) {
    const day = new Date(Date.UTC(y, mo, dom - back));
    const weekday = day.getUTCDay(); // 0 Sun .. 6 Sat
    if (weekday === 0 || weekday === 6) continue;

    const dy = day.getUTCFullYear();
    const dmo = day.getUTCMonth();
    const dd = day.getUTCDate();

    // 1–2 work blocks per day (morning / afternoon).
    const blocks = randInt(1, 2) === 1 ? [0] : [0, 1];
    for (const block of blocks) {
      const issueKey = u.tickets[ticketIdx++ % u.tickets.length]!;
      const repo = repoFor(issueKey);
      const branch = `feature/${issueKey}`;
      const isAI = rng() < u.aiBias;
      const startHour = block === 0 ? rand(9.3, 10.8) : rand(13.5, 15.2);

      let cursor = startHour;
      const push = (
        type: (typeof schema.eventType.enumValues)[number],
        source: (typeof schema.eventSource.enumValues)[number],
        metadata: Record<string, unknown>,
        advanceMin: number,
      ) => {
        const ts = manilaInstant(dy, dmo, dd, cursor);
        if (ts.getTime() <= nowMs) {
          events.push({
            eventUuid: uuid(),
            userId,
            source,
            type,
            repo,
            branch,
            issueKey,
            ts,
            metadata,
          });
        }
        cursor += advanceMin / 60;
      };

      // Start on the feature branch.
      push("branch_switch", "git_hook", { from_branch: "main", to_branch: branch }, randInt(2, 6));
      if (isAI) {
        push("session_start", "cc_hook", { tool: "claude-code", cwd_repo: repo }, randInt(3, 8));
      }

      const commits = randInt(2, 4);
      for (let c = 0; c < commits; c++) {
        if (isAI && rng() < 0.5) {
          push("tool_call", "mcp", { tool: pick(MCP_TOOLS) }, randInt(6, 14));
        }
        const meta: Record<string, unknown> = {
          sha: uuid().replace(/-/g, "").slice(0, 12),
          files_changed: randInt(1, 6),
          insertions: randInt(5, 140),
          deletions: randInt(0, 60),
        };
        if (isAI && rng() < 0.7) meta.ai_co_author = AI_CO_AUTHOR;
        push("commit", "git_hook", meta, randInt(14, 34));
      }

      push("push", "git_hook", { commit_count: commits, remote: "origin" }, randInt(2, 5));
      if (isAI) {
        push("session_end", "cc_hook", { tool: "claude-code", cwd_repo: repo }, 0);
      }
    }
  }

  return events;
}

// --- Main -----------------------------------------------------------------

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { ...pgOptions(url), max: 1 });
  const db = drizzle(sql, { schema, casing: "snake_case" });

  const nowMs = Date.now();

  // 1. Upsert demo users.
  const userIds = new Map<string, string>();
  for (const u of DEMO_USERS) {
    const [row] = await db
      .insert(schema.users)
      .values({ email: u.email, name: u.name, role: u.role })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: { name: u.name, role: u.role, tz: MANILA.tz },
      })
      .returning();
    userIds.set(u.email, row!.id);
  }
  const ids = [...userIds.values()];
  const allTickets = [...new Set(DEMO_USERS.flatMap((u) => u.tickets))];

  // 2. Clear prior demo data (idempotent re-seed).
  await db.delete(schema.taskSessions).where(inArray(schema.taskSessions.userId, ids));
  await db.delete(schema.events).where(inArray(schema.events.userId, ids));
  await db.delete(schema.taskEstimates).where(inArray(schema.taskEstimates.issueKey, allTickets));

  // 3. Generate + insert events, then stitch per user with the real algorithm.
  let totalEvents = 0;
  let totalSessions = 0;
  const ticketActual = new Map<string, { seconds: number; ai: boolean }>();

  for (const u of DEMO_USERS) {
    const userId = userIds.get(u.email)!;
    const events = generateForUser(userId, u, nowMs);
    totalEvents += events.length;

    for (let i = 0; i < events.length; i += 500) {
      await db.insert(schema.events).values(events.slice(i, i + 500));
    }

    const stitchEvents: StitchEvent[] = events.map((e) => ({
      id: e.eventUuid,
      type: e.type,
      source: e.source,
      issueKey: e.issueKey ?? null,
      repo: e.repo ?? null,
      branch: e.branch ?? null,
      ts: e.ts as Date,
      aiCoAuthor:
        (e.metadata as Record<string, unknown>)?.ai_co_author as string | undefined ?? null,
      toolName: (e.metadata as Record<string, unknown>)?.tool as string | undefined ?? null,
    }));

    const sessions = stitchUserEvents(stitchEvents, MANILA);
    totalSessions += sessions.length;

    if (sessions.length > 0) {
      await db.insert(schema.taskSessions).values(
        sessions.map((s) => ({
          userId,
          issueKey: s.issueKey,
          repo: s.repo,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          reportedSeconds: s.reportedSeconds,
          aiAssisted: s.aiAssisted,
          aiTool: s.aiTool,
          eventCount: s.eventCount,
          stitchVersion: 1,
        })),
      );
    }

    for (const s of sessions) {
      if (!s.issueKey) continue;
      const cur = ticketActual.get(s.issueKey) ?? { seconds: 0, ai: false };
      cur.seconds += s.reportedSeconds;
      cur.ai ||= s.aiAssisted;
      ticketActual.set(s.issueKey, cur);
    }
  }

  // 4. Synthesise estimates so compression + cohort charts read clearly:
  //    AI tickets land ~0.55–0.75× estimate, non-AI ~0.9–1.15×.
  let estimateCount = 0;
  for (const [issueKey, { seconds, ai }] of ticketActual) {
    if (seconds <= 0) continue;
    const targetRatio = ai ? rand(0.55, 0.75) : rand(0.9, 1.15);
    const estimateSeconds = Math.round(seconds / targetRatio);
    await db
      .insert(schema.taskEstimates)
      .values({ issueKey, estimateSeconds })
      .onConflictDoUpdate({
        target: schema.taskEstimates.issueKey,
        set: { estimateSeconds },
      });
    estimateCount++;
  }

  await sql.end();

  console.log("DevPulse demo data seeded:");
  console.log(`  users:     ${DEMO_USERS.length} (${DEMO_USERS.filter((u) => u.role === "lead").length} lead)`);
  console.log(`  events:    ${totalEvents}`);
  console.log(`  sessions:  ${totalSessions}`);
  console.log(`  estimates: ${estimateCount}`);
  console.log("");
  console.log("Dev login (DEV_LOGIN_ENABLED=true):");
  console.log("  dev  → alice@devpulse.local");
  console.log("  lead → dana@devpulse.local  (sees the Team view)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
