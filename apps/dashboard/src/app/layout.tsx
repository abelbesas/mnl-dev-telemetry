import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "DevPulse",
  description: "Client-agnostic developer telemetry",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
