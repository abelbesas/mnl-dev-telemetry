"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";
import type { SettingsState } from "@/components/WorkingHoursForm";

/** Revoke a single agent token, with a toast confirmation. */
export function RevokeTokenButton({
  action,
  tokenId,
}: {
  action: (state: SettingsState, formData: FormData) => Promise<SettingsState>;
  tokenId: string;
}) {
  const [state, formAction, pending] = useActionState<SettingsState, FormData>(
    action,
    {},
  );
  useToastOnResult(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="tokenId" value={tokenId} />
      <button className="btn danger" type="submit" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
    </form>
  );
}
