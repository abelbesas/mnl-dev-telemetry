"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string; leadOnly?: boolean }[] = [
  { href: "/timeline", label: "My timeline" },
  { href: "/drafts", label: "Drafts" },
  { href: "/team", label: "Team", leadOnly: true },
  { href: "/settings", label: "Settings" },
  { href: "/activate", label: "Activate device" },
];

export function Nav({ role }: { role: "dev" | "lead" }) {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {LINKS.filter((l) => !l.leadOnly || role === "lead").map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : ""}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
