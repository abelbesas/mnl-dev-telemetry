import {
  ActivateForm,
  type ActivateState,
} from "@/components/ActivateForm";
import { approveDeviceForUser } from "@/lib/device-approve";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSO-gated device activation (spec §4.3). A signed-in dev enters the code that
 * `npx @devpulse/setup` printed; the token is minted for *this* session's user
 * — the identity is never taken from the request.
 */
export default async function ActivatePage() {
  await requireUser();

  async function approve(
    _state: ActivateState,
    formData: FormData,
  ): Promise<ActivateState> {
    "use server";
    const user = await requireUser();
    const result = await approveDeviceForUser({
      userCode: String(formData.get("user_code") ?? ""),
      userId: user.id,
      label: String(formData.get("label") ?? "") || null,
    });
    if (result.ok) {
      return {
        ok: true,
        message: `Approved. Token "${result.label}" issued — return to the CLI; it will finish automatically.`,
      };
    }
    return { ok: false, message: result.error };
  }

  return (
    <div>
      <div className="page-head">
        <h1>Activate a device</h1>
        <p>
          Run <code className="mono">npx @devpulse/setup</code> on your machine,
          then enter the code it shows here to authorize its agent.
        </p>
      </div>
      <div className="card" style={{ maxWidth: 460 }}>
        <ActivateForm action={approve} />
      </div>
    </div>
  );
}
