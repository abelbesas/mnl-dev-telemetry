"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";
import type { DraftActionState } from "@/components/DraftRow";

/** "Approve all" for one day (brief §6D). */
export function ApproveDayButton({
  action,
  date,
  count,
}: {
  action: (
    state: DraftActionState,
    formData: FormData,
  ) => Promise<DraftActionState>;
  date: string;
  count: number;
}) {
  const [state, formAction, pending] = useActionState<DraftActionState, FormData>(
    action,
    {},
  );
  useToastOnResult(state);

  if (count === 0) return null;

  return (
    <form action={formAction}>
      <input type="hidden" name="date" value={date} />
      <button className="btn secondary" type="submit" disabled={pending}>
        {pending ? "Approving…" : `Approve all (${count})`}
      </button>
    </form>
  );
}
