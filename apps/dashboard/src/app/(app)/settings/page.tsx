import { revalidatePath } from "next/cache";
import {
  GenerateTokenForm,
  type TokenState,
} from "@/components/GenerateTokenForm";
import { formatDay } from "@/lib/format";
import {
  getUser,
  getUserTokens,
  issueToken,
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

export default async function SettingsPage() {
  const sessionUser = await requireUser();
  const user = (await getUser(sessionUser.id))!;
  const tokens = await getUserTokens(sessionUser.id);

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

  async function revoke(formData: FormData) {
    "use server";
    const u = await requireUser();
    const tokenId = String(formData.get("tokenId"));
    await revokeToken(u.id, tokenId);
    revalidatePath("/settings");
  }

  async function saveSettings(formData: FormData) {
    "use server";
    const u = await requireUser();
    const tz = String(formData.get("tz") ?? "Asia/Manila");
    const start = String(formData.get("workdayStart") ?? "09:00");
    const end = String(formData.get("workdayEnd") ?? "18:00");
    await updateWorkingHours(u.id, tz, start, end);
    revalidatePath("/settings");
  }

  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Working hours drive the stitcher's clamp; tokens authorize your agents.</p>
      </div>

      <div className="grid cols-2" style={{ marginBottom: "1.5rem" }}>
        <div className="card">
          <h3>Working hours</h3>
          <form action={saveSettings}>
            <label className="field">
              <span>Timezone</span>
              <select name="tz" defaultValue={user.tz}>
                {TIMEZONES.includes(user.tz) ? null : (
                  <option value={user.tz}>{user.tz}</option>
                )}
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <label className="field">
                <span>Start</span>
                <input type="time" name="workdayStart" defaultValue={user.workdayStart} />
              </label>
              <label className="field">
                <span>End</span>
                <input type="time" name="workdayEnd" defaultValue={user.workdayEnd} />
              </label>
            </div>
            <button className="btn" type="submit">
              Save working hours
            </button>
            <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.6rem" }}>
              Re-runs of the stitcher will clamp your sessions to this window
              (Mon–Fri).
            </p>
          </form>
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
                      <form action={revoke}>
                        <input type="hidden" name="tokenId" value={t.id} />
                        <button className="btn danger" type="submit">
                          Revoke
                        </button>
                      </form>
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
