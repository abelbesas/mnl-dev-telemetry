"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";

export interface EstimateState {
  ok?: boolean;
  message?: string;
}

/** Estimate editor with a toast confirmation (spec §4.5 Task detail). */
export function EstimateForm({
  action,
  issueKey,
  defaultHours,
}: {
  action: (state: EstimateState, formData: FormData) => Promise<EstimateState>;
  issueKey: string;
  defaultHours: number | "";
}) {
  const [state, formAction, pending] = useActionState<EstimateState, FormData>(
    action,
    {},
  );
  useToastOnResult(state);

  return (
    <form action={formAction}>
      <input type="hidden" name="issueKey" value={issueKey} />
      <label className="field">
        <span>Estimate (hours)</span>
        <input
          type="number"
          name="hours"
          min="0"
          step="0.25"
          defaultValue={defaultHours}
          placeholder="e.g. 8"
        />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save estimate"}
      </button>
    </form>
  );
}
