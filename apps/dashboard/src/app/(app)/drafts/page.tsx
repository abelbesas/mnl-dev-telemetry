import { revalidatePath } from "next/cache";
import Link from "next/link";
import { ApproveDayButton } from "@/components/ApproveDayButton";
import { DraftRow, type DraftActionState } from "@/components/DraftRow";
import { InfoTip } from "@/components/InfoTip";
import {
  approveDay,
  approveDraft,
  dismissDraft,
  getUserDraft,
  getUserDrafts,
  restoreDraft,
  updateDraft,
} from "@/lib/drafts";
import { formatDuration, toHours } from "@/lib/format";
import { getConnectionSummary } from "@/lib/jira/connection";
import { getUser } from "@/lib/queries";
import { localDateKey } from "@/lib/rollup";
import { runRollup } from "@/lib/rollup-run";
import { requireUser } from "@/lib/session";
import { runStitch } from "@/lib/stitch-run";
import { syncDraft } from "@/lib/sync-run";
import type { WorklogDraftRow } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How far back the default view reaches, in days. */
const WINDOW_DAYS = 14;

/**
 * Drafts — the core screen (spec §4.5). Nightly drafts listed by day, each
 * editable and approvable; approval is the mandatory human gate before anything
 * reaches Tempo (spec §2.5).
 */
export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const sessionUser = await requireUser();
  const user = (await getUser(sessionUser.id))!;
  const { show } = await searchParams;
  const showAll = show === "all";

  // Keep this dev's sessions and drafts current on load, so a fresh commit
  // shows up without waiting for the (daily) cron. Both are idempotent and
  // scoped to one user; neither may blank the page if it fails.
  try {
    await runStitch({ userId: sessionUser.id });
    await runRollup({ userId: sessionUser.id });
  } catch (err) {
    console.error("drafts: on-load stitch/rollup failed", err);
  }

  const now = new Date();
  const today = localDateKey(now, user.tz);
  const from = localDateKey(
    new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
    user.tz,
  );

  const drafts = await getUserDrafts(sessionUser.id, {
    from,
    statuses: showAll
      ? ["draft", "approved", "synced", "dismissed"]
      : ["draft", "approved"],
  });

  const connection = await getConnectionSummary(sessionUser.id).catch(() => null);
  const canSync = Boolean(connection && connection.tempoEnabled);

  // --- Server actions (own-data enforced inside each query) ---------------

  async function save(
    _state: DraftActionState,
    formData: FormData,
  ): Promise<DraftActionState> {
    "use server";
    const u = await requireUser();
    const draftId = String(formData.get("draftId"));
    const hours = Number(formData.get("hours"));
    const description = String(formData.get("description") ?? "");
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, message: "Enter a number of hours greater than zero." };
    }
    const result = await updateDraft(u.id, draftId, {
      seconds: Math.round(hours * 3600),
      description,
    });
    revalidatePath("/drafts");
    return result;
  }

  async function approve(
    _state: DraftActionState,
    formData: FormData,
  ): Promise<DraftActionState> {
    "use server";
    const u = await requireUser();
    const draftId = String(formData.get("draftId"));
    const isRetry = formData.get("retry") === "1";

    let draft: WorklogDraftRow | null;
    if (isRetry) {
      // Already approved; a retry just re-runs the push.
      draft = await getUserDraft(u.id, draftId);
      if (!draft) return { ok: false, message: "Draft not found." };
    } else {
      const approved = await approveDraft(u.id, draftId);
      if (!approved.ok || !approved.draft) {
        revalidatePath("/drafts");
        return { ok: false, message: approved.message };
      }
      draft = approved.draft;
    }

    // Approval enqueues sync (spec §4.5). `syncDraft` never throws — a failure
    // lands on the row as `sync_error`, so the page still renders.
    const outcome = await syncDraft(u.id, draft);
    revalidatePath("/drafts");
    return outcome.status === "synced"
      ? { ok: true, message: outcome.message }
      : {
          ok: false,
          message: `Approved, but not logged yet — ${outcome.message}`,
        };
  }

  async function approveAll(
    _state: DraftActionState,
    formData: FormData,
  ): Promise<DraftActionState> {
    "use server";
    const u = await requireUser();
    const date = String(formData.get("date"));
    const result = await approveDay(u.id, date);
    if (!result.ok) {
      revalidatePath("/drafts");
      return { ok: false, message: result.message };
    }

    let synced = 0;
    const failures: string[] = [];
    for (const draft of result.drafts) {
      const outcome = await syncDraft(u.id, draft);
      if (outcome.status === "synced") synced++;
      else failures.push(`${draft.issueKey}: ${outcome.message}`);
    }
    revalidatePath("/drafts");
    return failures.length === 0
      ? { ok: true, message: `Logged ${synced} worklog${synced === 1 ? "" : "s"} to Tempo` }
      : {
          ok: false,
          message: `${synced} logged, ${failures.length} pending — ${failures[0]}`,
        };
  }

  async function dismiss(
    _state: DraftActionState,
    formData: FormData,
  ): Promise<DraftActionState> {
    "use server";
    const u = await requireUser();
    const result = await dismissDraft(u.id, String(formData.get("draftId")));
    revalidatePath("/drafts");
    return result;
  }

  async function restore(
    _state: DraftActionState,
    formData: FormData,
  ): Promise<DraftActionState> {
    "use server";
    const u = await requireUser();
    const result = await restoreDraft(u.id, String(formData.get("draftId")));
    revalidatePath("/drafts");
    return result;
  }

  // --- Render -------------------------------------------------------------

  const pending = drafts.filter((d) => d.status === "draft");
  const pendingSeconds = pending.reduce((a, d) => a + d.seconds, 0);
  const syncedCount = drafts.filter((d) => d.status === "synced").length;
  const failedCount = drafts.filter(
    (d) => d.status === "approved" && d.syncError,
  ).length;

  const byDate = new Map<string, WorklogDraftRow[]>();
  for (const draft of drafts) {
    const list = byDate.get(draft.date) ?? [];
    list.push(draft);
    byDate.set(draft.date, list);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Drafts</h1>
        <p>
          Your time, rolled up per ticket per day. Nothing reaches Tempo until you
          approve it.
        </p>
      </div>

      {!connection ? (
        <div className="notice">
          <strong>Jira isn&apos;t linked.</strong> You can review and edit drafts
          now, but approving can&apos;t log anything yet.{" "}
          <Link href="/settings">Connect Jira in Settings →</Link>
        </div>
      ) : !canSync ? (
        <div className="notice">
          <strong>No Tempo token.</strong> Jira is linked, but Tempo is a separate
          vendor and needs its own token.{" "}
          <Link href="/settings">Add it in Settings →</Link>
        </div>
      ) : null}

      <div className="grid cols-3" style={{ marginBottom: "1.5rem" }}>
        <div className="card stat">
          <div className="label">
            Awaiting approval
            <InfoTip text="Drafts you haven't approved or dismissed yet. Approving one logs it to Tempo as you." />
          </div>
          <div className="value">{toHours(pendingSeconds)}h</div>
          <div className="sub">
            {pending.length} draft{pending.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Logged to Tempo</div>
          <div className="value">{syncedCount}</div>
          <div className="sub">last {WINDOW_DAYS} days</div>
        </div>
        <div className="card stat">
          <div className="label">
            Needs attention
            <InfoTip text="Drafts you approved that Tempo hasn't accepted yet. They retry automatically overnight; the error is shown on the row." />
          </div>
          <div className="value" style={{ color: failedCount ? "var(--bad)" : undefined }}>
            {failedCount}
          </div>
          <div className="sub">failed syncs</div>
        </div>
      </div>

      <div className="filter-bar">
        <span className="filter-label">Show</span>
        <Link className={`chip ${showAll ? "" : "on"}`} href="/drafts">
          Open
        </Link>
        <Link className={`chip ${showAll ? "on" : ""}`} href="/drafts?show=all">
          Everything
        </Link>
        <span className="spacer" />
        <span className="filter-note">
          Last {WINDOW_DAYS} days · {user.tz}
        </span>
      </div>

      {drafts.length === 0 ? (
        <div className="notice">
          No drafts in the last {WINDOW_DAYS} days. Drafts are built from your
          stitched sessions — commit on an instrumented machine (or run the demo
          seed), then reload.
        </div>
      ) : null}

      {[...byDate.entries()].map(([date, dayDrafts]) => {
        const openCount = dayDrafts.filter((d) => d.status === "draft").length;
        const dayTotal = dayDrafts
          .filter((d) => d.status !== "dismissed")
          .reduce((a, d) => a + d.seconds, 0);
        return (
          <div className="day-group" key={date}>
            <div className="day-label draft-day-label">
              <span>
                {date}
                {date === today ? " · today" : ""} · {formatDuration(dayTotal)}
              </span>
              <ApproveDayButton action={approveAll} date={date} count={openCount} />
            </div>
            {dayDrafts.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={{
                  id: draft.id,
                  issueKey: draft.issueKey,
                  date: draft.date,
                  hours: Math.round((draft.seconds / 3600) * 100) / 100,
                  description: draft.description ?? "",
                  status: draft.status,
                  syncError: draft.syncError,
                  tempoWorklogId: draft.tempoWorklogId,
                  syncedIssueKey: draft.syncedIssueKey,
                }}
                saveAction={save}
                approveAction={approve}
                dismissAction={dismiss}
                restoreAction={restore}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
