"use client";

import { useActionState } from "react";

export interface ActivateState {
  ok?: boolean;
  message?: string;
}

/** Device-activation form; shows the approval result inline (spec §4.3). */
export function ActivateForm({
  action,
}: {
  action: (state: ActivateState, formData: FormData) => Promise<ActivateState>;
}) {
  const [state, formAction, pending] = useActionState<ActivateState, FormData>(
    action,
    {},
  );

  return (
    <form action={formAction}>
      <label className="field">
        <span>Device code (from the CLI)</span>
        <input
          name="user_code"
          placeholder="WXYZ-ABCD"
          autoComplete="off"
          required
          style={{ textTransform: "uppercase", letterSpacing: "0.1em" }}
        />
      </label>
      <label className="field">
        <span>Label (optional)</span>
        <input name="label" placeholder="my-laptop" maxLength={64} />
      </label>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Approving…" : "Approve device"}
      </button>
      {state.message ? (
        <p
          className="notice"
          style={{
            marginTop: "0.85rem",
            borderColor: state.ok ? "var(--good)" : "var(--bad)",
            color: state.ok ? "var(--good)" : "var(--bad)",
          }}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
