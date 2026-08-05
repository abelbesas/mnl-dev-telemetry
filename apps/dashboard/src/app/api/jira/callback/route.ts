import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";
import { safeEqual } from "@/lib/crypto";
import { JiraClient, oauthTransport } from "@/lib/jira/client";
import { saveConnection } from "@/lib/jira/connection";
import {
  exchangeCodeForTokens,
  getOAuthConfig,
  listAccessibleResources,
  OAUTH_STATE_COOKIE,
} from "@/lib/jira/oauth";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth callback (brief §6A). Every failure path ends in a redirect back to
 * Settings with a readable message — an Atlassian hiccup must never render an
 * error page, and the message never contains token material.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  // One-shot: clear the state cookie whatever happens, so a code can't be
  // replayed against a still-valid state.
  jar.delete(OAUTH_STATE_COOKIE);

  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", appUrl()));

  const url = new URL(req.url);
  const denied = url.searchParams.get("error");
  if (denied) {
    const description = url.searchParams.get("error_description");
    return back(`Jira authorization was declined (${description ?? denied}).`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("Jira returned an incomplete response.");

  // CSRF: the state must match the cookie this browser was issued.
  if (!expectedState || !safeEqual(state, expectedState)) {
    return back("Jira authorization could not be verified — please try again.");
  }

  const config = getOAuthConfig();
  if (!config) return back("Jira OAuth is not configured on the server.");

  try {
    const token = await exchangeCodeForTokens(config, code);

    const resources = await listAccessibleResources(token.access_token);
    const site = resources[0];
    if (!site) {
      return back(
        "No Jira site was granted. Re-run the link and pick a site you have access to.",
      );
    }
    if (resources.length > 1) {
      // MVP: one site per dev. Picking the first is deterministic and visible
      // in Settings, so a wrong pick is obvious and fixable by re-linking.
      console.warn(
        `jira callback: ${resources.length} sites granted, using the first`,
      );
    }

    // The accountId is what Tempo needs as `authorAccountId`, so fetch it now
    // rather than on the first push — a broken link should fail here, visibly.
    const client = new JiraClient(
      oauthTransport(token.access_token, site.id, site.url),
    );
    const me = await client.myself();

    await saveConnection({
      userId: user.id,
      token,
      cloudId: site.id,
      siteUrl: site.url ?? "",
      label: site.name ?? site.url ?? "Jira",
      accountId: me.accountId,
    });

    // Audit the link (spec §5) — identity and site only, never the token.
    await getDb()
      .insert(auditLog)
      .values({
        userId: user.id,
        action: "jira.connect",
        target: site.id,
        metadata: { site: site.url ?? null, accountId: me.accountId },
      });

    const ok = new URL("/settings", appUrl());
    ok.searchParams.set("jira_ok", `Connected to ${site.name ?? site.url ?? "Jira"}`);
    return NextResponse.redirect(ok);
  } catch (err) {
    // Log the shape of the failure, not the payload.
    console.error("jira callback failed", err instanceof Error ? err.message : err);
    return back(
      err instanceof Error
        ? `Could not complete the Jira link: ${err.message}`
        : "Could not complete the Jira link.",
    );
  }
}

function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}

function back(message: string): NextResponse {
  const url = new URL("/settings", appUrl());
  url.searchParams.set("jira_error", message);
  return NextResponse.redirect(url);
}
