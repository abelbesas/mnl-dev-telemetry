"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";

export interface DraftActionState {
  ok?: boolean;
  message?: string;
}

export interface DraftView {
  id: string;
  issueKey: string;
  date: string;
  hours: number;
  description: string;
  status: "draft" | "approved" | "synced" | "dismissed";
  syncError: string | null;
  tempoWorklogId: string | null;
  /** Mirror ticket the time actually landed on, when it differs. */
  syncedIssueKey: string | null;
}

type Action = (
  state: DraftActionState,
  formData: FormData,
) => Promise<DraftActionState>;

/**
 * One draft row (brief §6D): editable seconds + description while it's still a
 * draft, then Approve / Dismiss. Once approved or synced the numbers are frozen
 * — they must keep matching what went to Tempo.
 */
export function DraftRow({
  draft,
  saveAction,
  approveAction,
  dismissAction,
  restoreAction,
}: {
  draft: DraftView;
  saveAction: Action;
  approveAction: Action;
  dismissAction: Action;
  restoreAction: Action;
}) {
  const [saveState, save, saving] = useActionState<DraftActionState, FormData>(
    saveAction,
    {},
  );
  const [approveState, approve, approving] = useActionState<
    DraftActionState,
    FormData
  >(approveAction, {});
  const [dismissState, dismiss, dismissing] = useActionState<
    DraftActionState,
    FormData
  >(dismissAction, {});
  const [restoreState, restore, restoring] = useActionState<
    DraftActionState,
    FormData
  >(restoreAction, {});

  useToastOnResult(saveState);
  useToastOnResult(approveState);
  useToastOnResult(dismissState);
  useToastOnResult(restoreState);

  const editable = draft.status === "draft";
  const busy = saving || approving || dismissing || restoring;

  return (
    <div className="session-row draft-row">
      <div className="key">
        <a href={`/tasks/${encodeURIComponent(draft.issueKey)}`}>{draft.issueKey}</a>
        <StatusBadge draft={draft} />
      </div>

      {editable ? (
        <form action={save} className="draft-edit">
          <input type="hidden" name="draftId" value={draft.id} />
          <input
            type="number"
            name="hours"
            step="0.25"
            min="0.25"
            max="24"
            defaultValue={draft.hours}
            aria-label={`Hours for ${draft.issueKey}`}
            className="draft-hours"
          />
          <input
            type="text"
            name="description"
            defaultValue={draft.description}
            aria-label={`Description for ${draft.issueKey}`}
            className="draft-desc"
            maxLength={500}
          />
          <button className="btn secondary" type="submit" disabled={busy}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      ) : (
        <div className="draft-edit draft-frozen">
          <span className="draft-hours-static">{draft.hours}h</span>
          <span className="muted draft-desc-static">{draft.description || "—"}</span>
        </div>
      )}

      <div className="draft-actions">
        {editable ? (
          <>
            <form action={approve}>
              <input type="hidden" name="draftId" value={draft.id} />
              <button className="btn" type="submit" disabled={busy}>
                {approving ? "Approving…" : "Approve"}
              </button>
            </form>
            <form action={dismiss}>
              <input type="hidden" name="draftId" value={draft.id} />
              <button className="btn secondary" type="submit" disabled={busy}>
                {dismissing ? "…" : "Dismiss"}
              </button>
            </form>
          </>
        ) : null}

        {draft.status === "approved" ? (
          <form action={approve}>
            <input type="hidden" name="draftId" value={draft.id} />
            <input type="hidden" name="retry" value="1" />
            <button className="btn secondary" type="submit" disabled={busy}>
              {approving ? "Retrying…" : "Retry sync"}
            </button>
          </form>
        ) : null}

        {draft.status === "dismissed" ? (
          <form action={restore}>
            <input type="hidden" name="draftId" value={draft.id} />
            <button className="btn secondary" type="submit" disabled={busy}>
              {restoring ? "…" : "Restore"}
            </button>
          </form>
        ) : null}
      </div>

      {draft.syncError ? (
        <div className="draft-error" role="status">
          <strong>Sync failed:</strong> {draft.syncError}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ draft }: { draft: DraftView }) {
  if (draft.status === "synced") {
    const mirrored =
      draft.syncedIssueKey && draft.syncedIssueKey !== draft.issueKey;
    return (
      <span className="badge" style={{ color: "var(--good)" }}>
        ✓ in Tempo
        {mirrored ? ` · via ${draft.syncedIssueKey}` : ""}
      </span>
    );
  }
  if (draft.status === "approved") {
    return (
      <span
        className="badge"
        style={{ color: draft.syncError ? "var(--bad)" : "var(--warn)" }}
      >
        {draft.syncError ? "sync failed" : "approved · syncing"}
      </span>
    );
  }
  if (draft.status === "dismissed") {
    return <span className="badge">dismissed</span>;
  }
  return null;
}
