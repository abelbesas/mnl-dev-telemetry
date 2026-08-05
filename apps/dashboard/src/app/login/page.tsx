import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { auth, isDevLoginEnabled, isGoogleEnabled, signIn } from "@/auth";

export const runtime = "nodejs";

/**
 * Sign-in page. Google Workspace SSO is the real path (spec §5); the dev-login
 * form appears only when DEV_LOGIN_ENABLED=true, letting the demo proceed
 * without waiting on SSO approval.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) redirect("/timeline");
  const { error } = await searchParams;

  async function googleSignIn() {
    "use server";
    try {
      await signIn("google", { redirectTo: "/timeline" });
    } catch (err) {
      // signIn throws NEXT_REDIRECT on success (re-throw it); an AuthError means
      // the attempt failed — surface it as a message instead of a crash.
      if (err instanceof AuthError) redirect(`/login?error=${err.type}`);
      throw err;
    }
  }

  async function devSignIn(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "");
    try {
      await signIn("dev-login", { email, redirectTo: "/timeline" });
    } catch (err) {
      if (err instanceof AuthError) redirect(`/login?error=${err.type}`);
      throw err;
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand">
          <picture>
            <source srcSet="/logo.webp" type="image/webp" />
            <img
              className="brand-mark"
              src="/logo.png"
              width={36}
              height={36}
              alt=""
            />
          </picture>
          {/* MnlDev<span>Telemetry</span> */}
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Sign in to see your timeline and time drafts.
        </p>

        {error ? (
          <p className="notice" style={{ borderColor: "var(--bad)" }}>
            Sign-in failed. Please try again.
          </p>
        ) : null}

        {isGoogleEnabled ? (
          <form action={googleSignIn} style={{ marginBottom: "1rem" }}>
            <button className="btn block" type="submit">
              Continue with Google
            </button>
          </form>
        ) : null}

        {isGoogleEnabled && isDevLoginEnabled ? (
          <div className="muted" style={{ textAlign: "center", margin: "0.5rem 0" }}>
            or
          </div>
        ) : null}

        {isDevLoginEnabled ? (
          <form action={devSignIn}>
            <label className="field">
              <span>Dev login — email</span>
              <input
                type="email"
                name="email"
                placeholder="you@company.com"
                required
                style={{ width: "100%" }}
              />
            </label>
            <button className="btn secondary block" type="submit">
              Dev sign-in
            </button>
            <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.6rem" }}>
              Dev login is enabled for this environment. It only assumes an
              existing user — no password, no new accounts.
            </p>
          </form>
        ) : null}

        {!isGoogleEnabled && !isDevLoginEnabled ? (
          <p className="notice">
            No sign-in method is configured. Set <code>AUTH_GOOGLE_ID</code> /
            <code>AUTH_GOOGLE_SECRET</code>, or <code>DEV_LOGIN_ENABLED=true</code>{" "}
            for local development.
          </p>
        ) : null}
      </div>
    </div>
  );
}
