import { currentSession } from "@/lib/auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getAllSettings, markSessionMfa, sessionSid, takeDuoState } from "@/lib/db";
import { duoPolicyFromSettings, recordDuoVerified } from "@/lib/duo-config";
import { DuoRefusedError, DuoUnreachableError, duoExchangeCode } from "@/lib/duo";
import { DuoTokenError } from "@/lib/duo-jwt";
import { DUO_STEP_DONE, DUO_STEP_PATH, duoConfigured, duoSettingsFrom } from "@/lib/duo-policy";
import { requestOrigin } from "@/lib/oauth";
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

/** Where "Test with my account" (Settings → Single sign-on) lands. */
const TEST_DONE = "/admin/sso";

function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const origin = requestOrigin(req);
  const url = new URL(req.url);
  const session = await currentSession();
  // No session at all (it expired while Duo's prompt was open): sign in again.
  if (!session) return redirectTo(`${origin}${loginHref("/")}`);

  const actor = actorFrom(session.user);
  const ip = ipFrom(req);
  const state = url.searchParams.get("state") || "";
  const row = state ? await takeDuoState(state, session.token) : undefined;
  if (!row || !row.same_session || row.expired) {
    const reason = !row ? "unknown_state" : !row.same_session ? "other_session" : "expired";
    await audit({ actor, action: "auth.duo_denied", details: { reason }, ip });
    return redirectTo(`${origin}${DUO_STEP_PATH}?e=expired`);
  }

  const test = row.purpose === "test";
  const returnTo = row.return_to === DUO_STEP_DONE ? DUO_STEP_DONE : safeReturnPath(row.return_to);
  const forDesk = row.return_to === DUO_STEP_DONE;
  /** Back to where the step was started, with the reason as a short code. */
  const fail = (code: string) => {
    if (test) return redirectTo(`${origin}${TEST_DONE}?duo_test=${code}#duo`);
    const q = new URLSearchParams({ e: code });
    if (forDesk) q.set("for", "desk");
    else if (returnTo !== "/") q.set("next", returnTo);
    return redirectTo(`${origin}${DUO_STEP_PATH}?${q}`);
  };

  const settings = await getAllSettings();
  const cfg = duoSettingsFrom(settings);
  // The credentials changed (or were removed) while the prompt was open: start again.
  if (!duoConfigured(cfg) || cfg.rev !== row.config_rev) {
    await audit({ actor, action: "auth.duo_denied", details: { reason: "settings_changed" }, ip });
    return fail("expired");
  }

  const code = url.searchParams.get("duo_code") || url.searchParams.get("code") || "";
  const duoError = Boolean(url.searchParams.get("error"));
  if (!code || duoError) {
    await audit({ actor, action: "auth.duo_denied", details: { reason: duoError ? "duo_error" : "no_code", ...(test ? { test: true } : {}) }, ip });
    return fail("denied");
  }

  try {
    await duoExchangeCode(cfg, { code, redirectUri: row.redirect_uri, username: row.username, nonce: row.nonce });
  } catch (e) {
    if (e instanceof DuoUnreachableError) {
      console.error(`[duo] token exchange failed: ${e.message}`);
      // Duo went down between the prompt and the answer. A test never passes
      // this way; a sign-in does only when the workspace lets people through.
      if (!test && duoPolicyFromSettings(settings)?.failOpen) {
        await markSessionMfa(session.token, "duo_unreachable");
        await audit({ actor, action: "auth.duo_unreachable_allowed", details: { stage: "token" }, ip });
        return redirectTo(`${origin}${returnTo}`);
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

  // Approved. The session has passed the Duo step as of now.
  if (!(await markSessionMfa(session.token, "duo"))) return redirectTo(`${origin}${loginHref("/")}`);
  if (test) {
    // "Test with my account": this admin, in this session, proved the saved
    // credentials work. That is what lets them switch a rule on.
    await recordDuoVerified({ rev: cfg.rev, sid: sessionSid(session.token), userId: session.user.id });
    await audit({ actor, action: "auth.duo_approved", details: { test: true }, ip });
    return redirectTo(`${origin}${TEST_DONE}?duo_test=ok#duo`);
  }
  await audit({ actor, action: "auth.duo_approved", ip });
  return redirectTo(`${origin}${returnTo}`);
}
