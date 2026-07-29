"use client";

import { useEffect, useState } from "react";

/**
 * Tiny dependency-free toast system. `toast(message)` dispatches a window event;
 * the <Toaster/> mounted in the app shell renders + auto-dismisses them. Client
 * form components call `toast()` after a server action resolves, so every
 * mutation gets a visible confirmation.
 */

export type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const TOAST_EVENT = "mnl-dev-telemetry:toast";
let counter = 0;

export function toast(message: string, type: ToastType = "success"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TOAST_EVENT, { detail: { message, type } }),
  );
}

/**
 * Fire a toast whenever a server-action result (useActionState) changes and
 * carries a message. `ok === false` shows an error toast, otherwise success.
 */
export function useToastOnResult(
  state: { ok?: boolean; message?: string } | undefined,
): void {
  useEffect(() => {
    if (state?.message) {
      toast(state.message, state.ok === false ? "error" : "success");
    }
    // Re-run whenever the action returns a fresh state object.
  }, [state]);
}

export function Toaster(): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent).detail as {
        message: string;
        type?: ToastType;
      };
      const id = ++counter;
      setItems((cur) => [
        ...cur,
        { id, message: detail.message, type: detail.type ?? "success" },
      ]);
      window.setTimeout(
        () => setItems((cur) => cur.filter((t) => t.id !== id)),
        3400,
      );
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
