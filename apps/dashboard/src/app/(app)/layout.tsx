import type { ReactNode } from "react";
import { signOut } from "@/auth";
import { Nav } from "@/components/Nav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Toaster } from "@/components/Toaster";
import { requireUser } from "@/lib/session";

export const runtime = "nodejs";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <picture>
            <source srcSet="/logo.webp" type="image/webp" />
            <img
              className="brand-mark"
              src="/logo.png"
              width={28}
              height={28}
              alt=""
            />
          </picture>
          MnlDev<span>Telemetry</span>
        </div>
        <Nav role={user.role} />
        <div className="sidebar-foot">
          <ThemeToggle />
          <div className="user-row">
            {/* `name` falls back to the email for auto-provisioned users, so
                only show the email line when it adds something. */}
            <span className="user-name" title={user.name}>
              {user.name}
            </span>
            <span className="badge role">{user.role}</span>
          </div>
          {user.email && user.email !== user.name ? (
            <div className="user-email" title={user.email}>
              {user.email}
            </div>
          ) : null}
          <form action={doSignOut}>
            <button className="btn danger block" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="content">{children}</main>
      <Toaster />
    </div>
  );
}
