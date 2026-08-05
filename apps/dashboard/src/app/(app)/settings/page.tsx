import { revalidatePath } from "next/cache";
import {
  GenerateTokenForm,
  type TokenState,
} from "@/components/GenerateTokenForm";
import {
  JiraConnectionCard,
  type JiraActionState,
} from "@/components/JiraConnectionCard";
import { RevokeTokenButton } from "@/components/RevokeTokenButton";
import { TempoTokenForm } from "@/components/TempoTokenForm";
import {
  WorkingHoursForm,
  type SettingsState,
} from "@/components/WorkingHoursForm";
import { isEncryptionConfigured } from "@/lib/crypto";
import {
  clearTempoToken,
  deleteConnection,
  getConnectionSummary,
  saveTempoToken,
} from "@/lib/jira/connection";
import { getOAuthConfig } from "@/lib/jira/oauth";
import { TempoClient } from "@/lib/jira/tempo";
import { formatDay } from "@/lib/format";
import {
  getUser,
  getUserTokens,
  issueToken,
  recordAudit,
  revokeToken,
  updateWorkingHours,
} from "@/lib/queries";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEZONES = [
  "Asia/Manila",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ jira_ok?: string; jira_error?: string }>;
}) {
  const sessionUser = await requireUser();
  const user = (await getUser(sessionUser.id))!;
  const tokens = await getUserTokens(sessionUser.id);
  const banner = await searchParams;

  const encryptionReady = isEncryptionConfigured();
  const oauthConfigured = getOAuthConfig() !== null;
  // A DB hiccup on the connection read must not blank the whole Settings page.
  const connection = encryptionReady
    ? await getConnectionSummary(sessionUser.id).catch((err) => {
        console.error("settings: jira connection read failed", err);
        return null;
      })
    : null;

  async function generateToken(
    _state: TokenState,
    formData: FormData,
  ): Promise<TokenState> {
    "use server";
    const u = await requireUser();
    const label =
      String(formData.get("label") ?? "").trim() ||
      `dashboard-${new Date().toISOString().slice(0, 10)}`;
    const token = await issueToken(u.id, label);
    revalidatePath("/settings");
    return { token, label };
  }

  async function revoke(
    _state: SettingsState,
    formData: FormData,
  ): Promise<SettingsState> {
    "use server";
    const u = await requireUser();
    const tokenId = String(formData.get("tokenId"));
    await revokeToken(u.id, tokenId);
    revalidatePath("/settings");
    return { ok: true, message: "Token revoked" };
  }

  async function saveSettings(
    _state: SettingsState,
    formData: FormData,
  ): Promise<SettingsState> {
    "use server";
    const u = await requireUser();
    const tz = String(formData.get("tz") ?? "Asia/Manila");
    const start = String(formData.get("workdayStart") ?? "09:00");
    const end = String(formData.get("workdayEnd") ?? "18:00");
    await updateWorkingHours(u.id, tz, start, end);
    revalidatePath("/settings");
    return { ok: true, message: "Working hours updated" };
  }

  async function disconnectJira(
    _state: JiraActionState,
    _formData: FormData,
  ): Promise<JiraActionState> {
    "use server";
    const u = await requireUser();
    // Scoped to the caller: a user can only ever delete their own connection.
    const removed = await deleteConnection(u.id);
    if (removed) await recordAudit(u.id, "jira.disconnect", null, {});
    revalidatePath("/settings");
    return removed
      ? { ok: true, message: "Jira disconnected — stored tokens deleted" }
      : { ok: false, message: "No Jira connection to disconnect" };
  }

  async function saveTempo(
    _state: JiraActionState,
    formData: FormData,
  ): Promise<JiraActionState> {
    "use server";
    const u = await requireUser();
    const token = String(formData.get("tempoToken") ?? "").trim();
    if (!token) return { ok: false, message: "Paste a Tempo API token first." };

    // Verify before storing, so a typo surfaces here rather than as a failed
    // sync hours later. A Tempo outage is reported, never thrown at the page.
    try {
      await new TempoClient(token).verifyToken();
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? `Tempo rejected that token: ${err.message}`
            : "Tempo rejected that token.",
      };
    }

    const saved = await saveTempoToken(u.id, token);
    if (!saved) return { ok: false, message: "Connect Jira before adding Tempo." };
    await recordAudit(u.id, "tempo.token.save", null, {});
    revalidatePath("/settings");
    return { ok: true, message: "Tempo token verified and saved" };
  }

  async function removeTempo(
    _state: JiraActionState,
    _formData: FormData,
  ): Promise<JiraActionState> {
    "use server";
    const u = await requireUser();
    await clearTempoToken(u.id);
    await recordAudit(u.id, "tempo.token.clear", null, {});
    revalidatePath("/settings");
    return { ok: true, message: "Tempo token removed" };
  }

  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Working hours drive the stitcher's clamp; tokens authorize your agents.</p>
      </div>

      {banner.jira_ok ? (
        <div className="notice" style={{ borderColor: "var(--good)" }}>
          {banner.jira_ok}
        </div>
      ) : null}
      {banner.jira_error ? (
        <div className="notice" style={{ borderColor: "var(--bad)" }}>
          {banner.jira_error}
        </div>
      ) : null}

      <div className="grid cols-2" style={{ marginBottom: "1.5rem" }}>
        <div className="card">
          <h3>Jira connection</h3>
          <JiraConnectionCard
            connection={
              connection
                ? {
                    siteUrl: connection.siteUrl,
                    label: connection.label,
                    accountId: connection.accountId,
                    status: connection.status,
                    statusReason: connection.statusReason,
                    tempoEnabled: connection.tempoEnabled,
                    connectedAt: formatDay(connection.connectedAt, user.tz),
                  }
                : null
            }
            configured={oauthConfigured}
            encryptionReady={encryptionReady}
            disconnectAction={disconnectJira}
          />
        </div>

        <div className="card">
          <h3>Tempo</h3>
          <TempoTokenForm
            saveAction={saveTempo}
            clearAction={removeTempo}
            hasToken={connection?.tempoEnabled ?? false}
            disabled={!connection}
          />
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1.5rem" }}>
        <div className="card">
          <h3>Working hours</h3>
          <WorkingHoursForm
            action={saveSettings}
            timezones={TIMEZONES}
            tz={user.tz}
            workdayStart={user.workdayStart}
            workdayEnd={user.workdayEnd}
          />
        </div>

        <div className="card">
          <h3>Issue an agent token</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Write-only credentials for git hooks / MCP on a dev machine. Only the
            hash is stored.
          </p>
          <GenerateTokenForm action={generateToken} />
        </div>
      </div>

      <div className="card">
        <h3>Agent tokens</h3>
        {tokens.length === 0 ? (
          <p className="muted">No tokens yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Created</th>
                <th>Last seen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td>{formatDay(t.createdAt)}</td>
                  <td>{t.lastSeenAt ? formatDay(t.lastSeenAt) : "never"}</td>
                  <td>
                    {t.revokedAt ? (
                      <span className="badge">revoked</span>
                    ) : (
                      <span className="badge" style={{ color: "var(--good)" }}>
                        active
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {t.revokedAt ? null : (
                      <RevokeTokenButton action={revoke} tokenId={t.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
