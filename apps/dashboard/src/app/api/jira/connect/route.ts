import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  buildAuthorizeUrl,
  getOAuthConfig,
  OAUTH_STATE_COOKIE,
} from "@/lib/jira/oauth";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start the per-user Jira OAuth link (brief §6A). Requires a dashboard session:
 * the connection is bound to the signed-in user, never to anything in the
 * request. A random `state` goes into an httpOnly cookie and into the authorize
 * URL; the callback refuses any mismatch.
 */
export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", appUrl()));
  }

  const config = getOAuthConfig();
  if (!config) {
    return NextResponse.redirect(
      settingsUrl("Jira OAuth is not configured on the server."),
    );
  }

  const state = randomBytes(32).toString("base64url");
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax", // survives the redirect back from auth.atlassian.com
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(config, state));
}

function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}

function settingsUrl(error: string): URL {
  const url = new URL("/settings", appUrl());
  url.searchParams.set("jira_error", error);
  return url;
}
