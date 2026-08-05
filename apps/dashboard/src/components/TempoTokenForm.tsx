"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";
import type { JiraActionState } from "@/components/JiraConnectionCard";

/**
 * Tempo credential entry (brief §4 decision). Tempo auth is NOT Jira auth, so
 * linking Jira does not grant Tempo access — each dev pastes their own Tempo API
 * token, which the server encrypts at rest. The token is write-once from the
 * UI's point of view: it is never rendered back, only replaced or cleared.
 */
export function TempoTokenForm({
  saveAction,
  clearAction,
  hasToken,
  disabled,
}: {
  saveAction: (
    state: JiraActionState,
    formData: FormData,
  ) => Promise<JiraActionState>;
  clearAction: (
    state: JiraActionState,
    formData: FormData,
  ) => Promise<JiraActionState>;
  hasToken: boolean;
  disabled: boolean;
}) {
  const [saveState, saveFormAction, saving] = useActionState<
    JiraActionState,
    FormData
  >(saveAction, {});
  const [clearState, clearFormAction, clearing] = useActionState<
    JiraActionState,
    FormData
  >(clearAction, {});
  useToastOnResult(saveState);
  useToastOnResult(clearState);

  if (disabled) {
    return (
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Connect Jira first — a Tempo worklog needs the Jira issue id and your
        Jira account id.
      </p>
    );
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Tempo is a separate vendor from Atlassian, so the Jira link doesn&apos;t
        cover it. Generate a token in <strong>Tempo → Settings → Data Access →
        API integration</strong> and paste it here. Stored encrypted, server-side
        only — it never reaches your machine.
      </p>
      <form action={saveFormAction}>
        <label className="field">
          <span>Tempo API token</span>
          <input
            type="password"
            name="tempoToken"
            autoComplete="off"
            placeholder={hasToken ? "•••••••• (saved — paste to replace)" : "paste token"}
          />
        </label>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Checking…" : hasToken ? "Replace token" : "Save token"}
        </button>
      </form>
      {hasToken ? (
        <form action={clearFormAction} style={{ marginTop: "0.6rem" }}>
          <button className="btn secondary" type="submit" disabled={clearing}>
            {clearing ? "Removing…" : "Remove Tempo token"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
