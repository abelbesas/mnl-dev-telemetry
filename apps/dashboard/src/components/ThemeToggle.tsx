"use client";

import { useEffect, useState } from "react";

/**
 * Dark/light theme switch. The chosen theme is stamped on <html data-theme>
 * and persisted to localStorage; the inline script in the root layout applies
 * it before first paint so there is no flash. With nothing stored we follow the
 * OS (prefers-color-scheme), which is what `resolved` reports back.
 */

export const THEME_STORAGE_KEY = "mnl-dev-telemetry-theme";

type Theme = "dark" | "light";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    setTheme(stored === "light" || stored === "dark" ? stored : systemTheme());
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  // Render a stable placeholder until the effect resolves, so server and
  // client markup match.
  const current = theme ?? "dark";
  const next: Theme = current === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <span aria-hidden="true">{current === "dark" ? "☾" : "☀"}</span>
      <span>{current === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
