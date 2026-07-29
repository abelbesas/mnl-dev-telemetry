"use client";

import { useActionState, useEffect } from "react";
import { toast } from "@/components/Toaster";

export interface TokenState {
  token?: string;
  label?: string;
  error?: string;
}

/**
 * Client wrapper so a freshly-issued agent token can be shown exactly once
 * (spec §5: only the hash is stored). The plaintext lives only in this
 * component's transient state — it is never re-rendered from the server.
 */
export function GenerateTokenForm({
  action,
}: {
  action: (state: TokenState, formData: FormData) => Promise<TokenState>;
}) {
  const [state, formAction, pending] = useActionState<TokenState, FormData>(
    action,
    {},
  );

  useEffect(() => {
    if (state.token) toast(`Agent token "${state.label ?? "new"}" created`);
    else if (state.error) toast(state.error, "error");
  }, [state]);

  return (
    <div>
      <form action={formAction}>
        <div className="row">
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span>Label</span>
            <input name="label" placeholder="my-laptop" maxLength={64} />
          </label>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Generating…" : "Generate token"}
          </button>
        </div>
      </form>
      {state.token ? (
        <div className="token-plaintext mono" style={{ marginTop: "0.75rem" }}>
          {state.token}
          <div className="muted" style={{ marginTop: "0.4rem" }}>
            Copy this now — it is shown once. Give it to{" "}
            <code>npx @devpulse/setup</code> on the dev machine.
          </div>
        </div>
      ) : null}
      {state.error ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
