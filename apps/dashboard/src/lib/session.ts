import { redirect } from "next/navigation";
import { auth } from "@/auth";

/**
 * Server-side session guards. Pages call these so authorization is enforced
 * where the data is read — never in the client alone (spec §2.6). `requireLead`
 * additionally gates the aggregate/team views on `role`.
 */

export interface SessionUser {
  id: string;
  role: "dev" | "lead";
  email: string;
  name: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) return null;
  return {
    id: u.id,
    role: u.role,
    email: u.email ?? "",
    name: u.name ?? u.email ?? "",
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireLead(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "lead") redirect("/timeline");
  return user;
}
