import { currentSession } from "@/lib/auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getAllSettings, markSessionMfa, sessionSid, takeDuoState } from "@/lib/db";
import { duoPolicyFromSettings, withDuoSettings } from "@/lib/duo-config";
import { DuoRefusedError, DuoUnreachableError, duoExchangeCode, duoHealthCheck } from "@/lib/duo";
import { DuoTokenError } from "@/lib/duo-jwt";
import { DUO_STEP_DONE, DUO_STEP_PATH, cleanOrigin, duoConfigured, duoSettingsFrom, isDeskPath, validDuoCode } from "@/lib/duo-policy";
import { duoCallbackRateLimited } from "@/lib/rate-limit";
import { loginHref, safeReturnPath } from "@/lib/return-to";

export const dynamic = "force-dynamic";

// Where Duo sends the browser back (1.20.5), with ?duo_code=…&state=….
//
// The state is taken (deleted) first, so it works once. It must have been
// started by THIS session and still be inside its five minutes: a callback
// for another session, a replayed one and an expired one are all refused.
// Then the code is exchanged at Duo's token endpoint and the ID token is
// verified (lib/duo-jwt). Only "allow" for the username we sent, with our
// nonce, marks the session as having passed.
//
// Like the SSO callback, only short codes cross the redirect back to the
// step page; details go to the server log and the audit log. Neither ever
// holds the code, the token or the secret.
//
// Every redirect from here is a PATH on this same site. No address is built
// from the request's Host header.
//
// When Duo cannot be reached at this stage, the workspace's "let people in"
// setting applies only if a fresh health check cannot reach Duo either. A
// token endpoint that fails on its own is not Duo being down.

/** Where "Test with my account" (Settings → Single sign-on) lands. */
const TEST_DONE = "/admin/sso";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { location: path, "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const session = await currentSession();
  // No session at all (it expired while Duo's prompt was open): sign in again.
  if (!session) return redirectTo(loginHref("/"));

  // Each refusal below writes an audit row, so one session cannot ask for
  // more than a handful: past the limit nothing is read and nothing is written.
  const sid = sessionSid(session.token);
  if (duoCallbackRateLimited(sid)) return redirectTo(`${DUO_STEP_PATH}?e=limited`);

  const actor = actorFrom(session.user);
  const ip = ipFrom(req);
  const state = url.searchParams.get("state") || "";
  const row = state ? await takeDuoState(state, session.token) : undefined;
  if (!row || !row.same_session || row.expired) {
    const reason = !row ? "unknown_state" : !row.same_session ? "other_session" : "expired";
    await audit({ actor, action: "auth.duo_denied", details: { reason }, ip });
    return redirectTo(`${DUO_STEP_PATH}?e=expired`);
  }

  const test = row.purpose === "test";
  const returnTo = row.return_to === DUO_STEP_DONE ? DUO_STEP_DONE : safeReturnPath(row.return_to);
  const forDesk = row.return_to === DUO_STEP_DONE;
  /** Back to where the step was started, with the reason as a short code. */
  const fail = (code: string) => {
    if (test) return redirectTo(`${TEST_DONE}?duo_test=${code}#duo`);
    const q = new URLSearchParams({ e: code });
    if (forDesk) q.set("for", "desk");
    else {
      // Only the desk rule was owed, on the way to a page outside /desk: keep asking for it.
      if (!session.duo.signIn && session.duo.desk && !isDeskPath(returnTo)) q.set("scope", "desk");
      if (returnTo !== "/") q.set("next", returnTo);
    }
    return redirectTo(`${DUO_STEP_PATH}?${q}`);
  };

  const settings = await getAllSettings();
  const cfg = duoSettingsFrom(settings);
  // The configuration changed (or was removed) while the prompt was open: start again.
  if (!duoConfigured(cfg) || cfg.rev !== row.config_rev) {
    await audit({ actor, action: "auth.duo_denied", details: { reason: "settings_changed" }, ip });
    return fail("expired");
  }

  const code = url.searchParams.get("duo_code") || url.searchParams.get("code") || "";
  const duoError = Boolean(url.searchParams.get("error"));
  // No code, Duo's own error, or something that is not a Duo code at all: a
  // denial, and Duo is not called with it.
  if (!code || duoError || !validDuoCode(code)) {
    const reason = duoError ? "duo_error" : code ? "bad_code" : "no_code";
    await audit({ actor, action: "auth.duo_denied", details: { reason, ...(test ? { test: true } : {}) }, ip });
    return fail("denied");
  }

  try {
    await duoExchangeCode(cfg, { code, redirectUri: row.redirect_uri, username: row.username, nonce: row.nonce });
  } catch (e) {
    if (e instanceof DuoUnreachableError) {
      console.error(`[duo] token exchange failed: ${e.message}`);
      // Duo went down between the prompt and the answer. A test never passes
      // this way. A sign-in does only when the workspace lets people through
      // AND Duo really is unreachable: its health check must fail the same way now.
      if (!test && duoPolicyFromSettings(settings)?.failOpen && (await duoUnreachableNow(cfg))) {
        await markSessionMfa(session.token, "duo_unreachable");
        await audit({ actor, action: "auth.duo_unreachable_allowed", details: { stage: "token" }, ip });
        return redirectTo(returnTo);
      }
      await audit({ actor, action: "auth.duo_unreachable_blocked", details: { stage: "token", reason: "unreachable", ...(test ? { test: true } : {}) }, ip });
      return fail("unreachable");
    }
    if (e instanceof DuoRefusedError || e instanceof DuoTokenError) {
      const reason = e instanceof DuoTokenError ? e.problem : "exchange_refused";
      console.error(`[duo] sign-in check refused: ${reason}${e instanceof DuoRefusedError ? ` (${e.message})` : ""}`);
      await audit({ actor, action: "auth.duo_denied", details: { reason, ...(test ? { test: true } : {}) }, ip });
      return fail("denied");
    }
    throw e;
  }

  if (test) {
    // "Test with my account": this admin, in this session, proved the saved
    // configuration works, at this address. That is what lets them switch a
    // rule on, and (with no custom domain) where every Duo step returns to.
    // Recorded under the settings lock, and only if the configuration is
    // still the one the test ran against.
    const origin = cleanOrigin(new URL(row.redirect_uri).origin);
    const recorded =
      origin !== null &&
      (await withDuoSettings(async (tx) => {
        if ((await tx.read()).rev !== row.config_rev) return false;
        await tx.recordVerified({ rev: row.config_rev, sid, userId: session.user.id, origin });
        return true;
      }));
    if (!recorded) {
      await audit({ actor, action: "auth.duo_denied", details: { reason: "settings_changed", test: true }, ip });
      return fail("expired");
    }
  }
  // Approved. The session has passed the Duo step as of now.
  if (!(await markSessionMfa(session.token, "duo"))) return redirectTo(loginHref("/"));
  if (test) {
    await audit({ actor, action: "auth.duo_approved", details: { test: true }, ip });
    return redirectTo(`${TEST_DONE}?duo_test=ok#duo`);
  }
  await audit({ actor, action: "auth.duo_approved", ip });
  return redirectTo(returnTo);
}

/** Is Duo unreachable right now (its health check gets no answer, times out or answers 5xx)? */
async function duoUnreachableNow(cfg: Parameters<typeof duoHealthCheck>[0]): Promise<boolean> {
  try {
    await duoHealthCheck(cfg);
    return false;
  } catch (e) {
    return e instanceof DuoUnreachableError;
  }
}
