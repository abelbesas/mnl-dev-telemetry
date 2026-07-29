import type { ReactNode } from "react";
import { signOut } from "@/auth";
import { Nav } from "@/components/Nav";
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
          Dev<span>Pulse</span>
        </div>
        <Nav role={user.role} />
        <div className="sidebar-foot">
          <div style={{ marginBottom: 6 }}>
            {user.name}
            <span className="badge role" style={{ marginLeft: 6 }}>
              {user.role}
            </span>
          </div>
          <div className="mono" style={{ fontSize: "0.72rem", marginBottom: 8 }}>
            {user.email}
          </div>
          <form action={doSignOut}>
            <button className="btn danger" type="submit" style={{ width: "100%" }}>
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
