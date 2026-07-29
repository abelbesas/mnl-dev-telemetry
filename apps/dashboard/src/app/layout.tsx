import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "DevPulse",
  description: "Client-agnostic developer telemetry",
};

/**
 * Applies the stored theme before first paint so switching pages never flashes
 * the wrong palette. Falls back to the OS preference when nothing is stored.
 */
const themeScript = `(function(){try{var t=localStorage.getItem("devpulse-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
