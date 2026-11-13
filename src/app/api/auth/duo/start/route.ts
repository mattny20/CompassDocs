import { NextResponse } from "next/server";
import { crossOriginRejection } from "@/lib/api-auth";
import { currentSession } from "@/lib/auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getAllSettings, markSessionMfa, saveDuoState, sessionSid } from "@/lib/db";
import { duoPolicyFromSettings, duoReturnOrigin } from "@/lib/duo-config";
import { DUO_STEP_TTL, DuoRefusedError, DuoUnreachableError, duoAuthorizeUrl, duoHealthCheck, duoUsernameFor, newDuoStep } from "@/lib/duo";
import { DUO_STEP_DONE, duoConfigured, duoSettingsFrom } from "@/lib/duo-policy";
import { requestOrigin } from "@/lib/oauth";
import { duoStartRateLimited } from "@/lib/rate-limit";
import { safeReturnPath } from "@/lib/return-to";

export const dynamic = "force-dynamic";

// Start the Duo step for this session (1.20.5): check Duo is up, remember a
// single-use state bound to this session, and answer with the address of
// Duo's prompt. The page (components/auth/DuoStep) then sends the browser
// there. A POST with the same-origin check, never a GET: each start can send
// a push to a phone, so another site must not be able to trigger one.
//
// The session here has usually NOT passed Duo yet, so this reads
// currentSession, not getCurrentUser.
//
// Where Duo sends the browser back is NOT taken from this request
// (lib/duo-config duoReturnOrigin): it is the workspace's custom domain, or
// the address the admin's test was run on. Asked from any other address,
// the step does not start.
//
// Answers: { redirect } to go on (Duo's prompt, or the page they wanted when
// nothing is owed or Duo is down and the workspace lets people through);
// 503 { code: "duo_unreachable" }, 502 { code: "duo_refused" } or
// 409 { code: "duo_wrong_address" } otherwise.
export async function POST(req: Request) {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { next?: unknown; for?: unknown } | null;
  // After the step: the page they wanted, or (asked from inside the desk, in
  // a second tab) the "you can close this tab" page.
  const returnTo = body?.for === "desk" ? DUO_STEP_DONE : safeReturnPath(typeof body?.next === "string" ? body.next : "/");

  const settings = await getAllSettings();
  const policy = duoPolicyFromSettings(settings);
  // Nothing is enforced (switched off meanwhile), or this account skips Duo.
  if (!policy || policy.bypass.has(session.user.id)) return NextResponse.json({ redirect: returnTo });

  if (duoStartRateLimited(session.user.id, sessionSid(session.token))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes, then try again." }, { status: 429 });
  }

  const cfg = duoSettingsFrom(settings);
  const actor = actorFrom(session.user);
  const ip = ipFrom(req);
  // A rule is on but the saved details cannot be used (lib/duo-policy duoPolicy): stop here, and say so.
  if (!duoConfigured(cfg)) {
    console.error("[duo] a Duo rule is on but the Client ID, Client secret or API hostname is missing or unreadable");
    await audit({ actor, action: "auth.duo_unreachable_blocked", details: { stage: "settings", reason: "not_set_up" }, ip });
    return NextResponse.json({ error: "Duo is not set up correctly on this workspace.", code: "duo_refused" }, { status: 502 });
  }
  const back = duoReturnOrigin(settings, requestOrigin(req), "signin");
  if (!back.ok) {
    if (back.reason === "not_tested") {
      console.error("[duo] a Duo rule is on but no tested address is recorded; run Test with my account again");
      await audit({ actor, action: "auth.duo_unreachable_blocked", details: { stage: "settings", reason: "no_tested_address" }, ip });
      return NextResponse.json({ error: "Duo is not set up correctly on this workspace.", code: "duo_refused" }, { status: 502 });
    }
    return NextResponse.json(
      { error: `Duo is set up for ${back.pinned}. Open CompassDocs at that address and sign in there.`, code: "duo_wrong_address" },
      { status: 409 }
    );
  }

  try {
    await duoHealthCheck(cfg);
  } catch (e) {
    if (e instanceof DuoUnreachableError && policy.failOpen) {
      // Duo is down and the workspace chose to let people through, for an
      // hour (lib/duo-policy DUO_UNREACHABLE_PASS_MS). Said in the audit log each time.
      await markSessionMfa(session.token, "duo_unreachable");
      await audit({ actor, action: "auth.duo_unreachable_allowed", details: { stage: "health_check" }, ip });
      return NextResponse.json({ redirect: returnTo });
    }
    if (e instanceof DuoUnreachableError || e instanceof DuoRefusedError) {
      const refused = e instanceof DuoRefusedError;
      console.error(`[duo] health check ${refused ? "refused" : "failed"}: ${e.message}`);
      await audit({ actor, action: "auth.duo_unreachable_blocked", details: { stage: "health_check", reason: refused ? "refused" : "unreachable" }, ip });
      return refused
        ? NextResponse.json({ error: "Duo did not accept this workspace's Duo details.", code: "duo_refused" }, { status: 502 })
        : NextResponse.json({ error: "Duo can't be reached right now.", code: "duo_unreachable" }, { status: 503 });
    }
    throw e;
  }

  const step = newDuoStep();
  const username = duoUsernameFor(session.user, cfg.usernameSource);
  const redirectUri = `${back.origin}/api/auth/duo/callback`;
  await saveDuoState({
    state: step.state,
    token: session.token,
    nonce: step.nonce,
    username,
    purpose: "signin",
    returnTo,
    redirectUri,
    configRev: cfg.rev,
    ttlSeconds: DUO_STEP_TTL,
  });
  return NextResponse.json({ redirect: duoAuthorizeUrl(cfg, { ...step, username, redirectUri }) });
}
