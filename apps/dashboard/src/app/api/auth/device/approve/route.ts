import { NextResponse } from "next/server";
import { z } from "zod";
import type { DeviceApproveResponse } from "@devpulse/shared";
import { auth } from "@/auth";
import { approveDeviceForUser } from "@/lib/device-approve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/device/approve — approve a pending device authorization for the
 * signed-in user (spec §4.3 / §5).
 *
 * Phase 4 SSO-gates this: the Phase-2 version trusted an `email` in the body as
 * a stand-in for SSO. Now the identity is derived from the dashboard session, so
 * the body carries only the `user_code` (and an optional token label). The
 * primary human path is the `/activate` page; this endpoint remains for
 * authenticated programmatic use.
 */
const bodySchema = z.object({
  user_code: z.string().min(1),
  label: z.string().max(64).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await approveDeviceForUser({
    userCode: parsed.data.user_code,
    userId: session.user.id,
    label: parsed.data.label,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const body: DeviceApproveResponse = { ok: true, user_code: result.userCode };
  return NextResponse.json(body, { status: 200 });
}
