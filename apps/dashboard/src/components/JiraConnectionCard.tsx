"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";

export interface JiraActionState {
  ok?: boolean;
  message?: string;
}

export interface JiraConnectionView {
  siteUrl: string | null;
  label: string;
  accountId: string | null;
  status: "active" | "broken";
  statusReason: string | null;
  tempoEnabled: boolean;
  connectedAt: string;
}

/**
 * Settings card for the per-user Jira link (brief §6A). Shows the connected
 * site + account, a Disconnect button, and — when a token refresh has failed —
 * a "reconnect" prompt rather than letting syncs fail silently.
 */
export function JiraConnectionCard({
  connection,
  configured,
  encryptionReady,
  disconnectAction,
}: {
  connection: JiraConnectionView | null;
  configured: boolean;
  encryptionReady: boolean;
  disconnectAction: (
    state: JiraActionState,
    formData: FormData,
  ) => Promise<JiraActionState>;
}) {
  const [state, formAction, pending] = useActionState<JiraActionState, FormData>(
    disconnectAction,
    {},
  );
  useToastOnResult(state);

  if (!configured || !encryptionReady) {
    return (
      <div className="notice">
        <strong>Jira link unavailable.</strong>{" "}
        {!configured
          ? "Set JIRA_OAUTH_CLIENT_ID and JIRA_OAUTH_CLIENT_SECRET on the server."
          : "Set ENCRYPTION_KEY on the server — credentials are never stored unencrypted."}
      </div>
    );
  }

  if (!connection) {
    return (
      <div>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Link your own Jira so worklogs are authored as you. You authorize in
          the browser; the token is stored encrypted on the server and never
          reaches your machine.
        </p>
        <a className="btn" href="/api/jira/connect">
          Connect Jira
        </a>
      </div>
    );
  }

  const broken = connection.status === "broken";

  return (
    <div>
      {broken ? (
        <div className="notice" style={{ marginTop: 0 }}>
          <strong>Reconnect needed.</strong>{" "}
          {connection.statusReason ?? "The stored Jira authorization is no longer valid."}
        </div>
      ) : null}

      <table>
        <tbody>
          <tr>
            <th>Site</th>
            <td>
              {connection.siteUrl ? (
                <a href={connection.siteUrl} target="_blank" rel="noreferrer">
                  {connection.label}
                </a>
              ) : (
                connection.label
              )}
            </td>
          </tr>
          <tr>
            <th>Jira account</th>
            <td className="mono">{connection.accountId ?? "—"}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td>
              <span
                className="badge"
                style={{ color: broken ? "var(--bad)" : "var(--good)" }}
              >
                {broken ? "reconnect" : "active"}
              </span>
            </td>
          </tr>
          <tr>
            <th>Tempo</th>
            <td>
              <span
                className="badge"
                style={{
                  color: connection.tempoEnabled ? "var(--good)" : "var(--muted)",
                }}
              >
                {connection.tempoEnabled ? "token saved" : "no token"}
              </span>
            </td>
          </tr>
          <tr>
            <th>Connected</th>
            <td className="muted">{connection.connectedAt}</td>
          </tr>
        </tbody>
      </table>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <a className="btn secondary" href="/api/jira/connect">
          {broken ? "Reconnect Jira" : "Re-link"}
        </a>
        <form action={formAction}>
          <button className="btn danger" type="submit" disabled={pending}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </button>
        </form>
      </div>
    </div>
  );
}
