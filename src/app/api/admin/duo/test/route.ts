import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { currentSession } from "@/lib/auth";
import { getAllSettings, saveDuoState, sessionSid } from "@/lib/db";
import { duoReturnOrigin } from "@/lib/duo-config";
import { DUO_STEP_TTL, DuoRefusedError, DuoUnreachableError, duoAuthorizeUrl, duoHealthCheck, duoUsernameFor, newDuoStep } from "@/lib/duo";
import { duoConfigured, duoSettingsFrom } from "@/lib/duo-policy";
import { featureEnabled } from "@/lib/ee";
import { requestOrigin } from "@/lib/oauth";
import { duoStartRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// "Test with my account" (1.20.5): send the admin through a real Duo
// approval with the credentials that are SAVED (never ones still in the
// form), and come back to Settings → Single sign-on. A pass is recorded
// against this session and these credentials (api/auth/duo/callback), and
// only then can a rule be switched on. Nothing is enforced by a test.
//
// A pass also records the address the test was run on. With no custom
// domain, that address is where every later Duo step returns to.
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "identity.sso_manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("sso"))) {
    return NextResponse.json({ error: "The Duo sign-in check needs an Enterprise licence with SSO." }, { status: 402 });
  }
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const settings = await getAllSettings();
  const cfg = duoSettingsFrom(settings);
  if (!duoConfigured(cfg)) return NextResponse.json({ error: "Save the Client ID, Client secret and API hostname first." }, { status: 400 });
  // Where Duo sends the browser back (lib/duo-config duoReturnOrigin): the
  // custom domain when there is one, else the address this test is being run
  // on, which a pass then records as THE address for every sign-in step.
  const back = duoReturnOrigin(settings, requestOrigin(req), "test");
  if (!back.ok) {
    return NextResponse.json(
      {
        error: back.pinned
          ? `Duo is in use at ${back.pinned}. Run the test at that address. To move CompassDocs to another address, turn both rules off first.`
          : "The address this request came on could not be read. Open CompassDocs at its usual address and try again.",
      },
      { status: 409 }
    );
  }
  if (duoStartRateLimited(gate.id, sessionSid(session.token))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes, then try again." }, { status: 429 });
  }

  try {
    await duoHealthCheck(cfg);
  } catch (e) {
    if (e instanceof DuoRefusedError) {
      console.error(`[duo] test: health check refused: ${e.message}`);
      return NextResponse.json({ error: "Duo did not accept these details. Check the Client ID, the Client secret and the API hostname." }, { status: 502 });
    }
    if (e instanceof DuoUnreachableError) {
      console.error(`[duo] test: health check failed: ${e.message}`);
      return NextResponse.json({ error: "Duo can't be reached from this server. Check the API hostname and that the server can reach it over HTTPS." }, { status: 503 });
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
    purpose: "test",
    returnTo: "/admin/sso",
    redirectUri,
    configRev: cfg.rev,
    ttlSeconds: DUO_STEP_TTL,
  });
  return NextResponse.json({ redirect: duoAuthorizeUrl(cfg, { ...step, username, redirectUri }), username });
}
