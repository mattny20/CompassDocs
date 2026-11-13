import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { currentSession } from "@/lib/auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { listUsers, sessionSid } from "@/lib/db";
import { duoVerifiedBy, getDuoSettings, saveDuoSettings, type DuoSettingsPatch } from "@/lib/duo-config";
import { sameText } from "@/lib/duo-jwt";
import {
  DUO_BYPASS_MAX,
  DUO_DESK_HOURS_MAX,
  DUO_DESK_HOURS_MIN,
  duoConfigured,
  normalizeDuoHost,
  validDuoClientId,
  validDuoClientSecret,
  type DuoSettings,
} from "@/lib/duo-policy";
import { duoView } from "@/lib/duo-view";
import { featureEnabled } from "@/lib/ee";

export const dynamic = "force-dynamic";

// Settings → Single sign-on → Duo (1.20.5). The client secret is write-only:
// it is never returned, logged or audited; GET only says whether one is
// stored.
//
// The rules that keep a workspace from locking itself out live here, on the
// server, not in the form:
//   - a rule ("at sign-in", "when opening the desk") can be switched on only
//     by an admin who has completed "Test with my account" (a real Duo
//     approval) in this same session, against the credentials now saved;
//   - changing the client ID, the secret or the API hostname forgets that
//     test and switches both rules off until it is run again.

async function sidOf(): Promise<string> {
  const s = await currentSession();
  return s ? sessionSid(s.token) : "";
}

export async function GET() {
  const gate = await apiGuard("admin", "identity.sso_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await duoView(gate.id, await sidOf()));
}

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "identity.sso_manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("sso"))) {
    return NextResponse.json({ error: "The Duo sign-in check needs an Enterprise licence with SSO." }, { status: 402 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return bad("Invalid request.");

  const cur = await getDuoSettings();
  const sid = await sidOf();
  const patch: DuoSettingsPatch = {};

  if (body.client_id !== undefined) {
    const v = String(body.client_id).trim();
    if (v && !validDuoClientId(v)) return bad("The Client ID is 20 letters and digits. Copy it from the Web SDK application in the Duo Admin Panel.");
    patch.clientId = v;
  }
  if (typeof body.client_secret === "string" && body.client_secret !== "") {
    const v = body.client_secret.trim();
    if (!validDuoClientSecret(v)) return bad("The Client secret is 40 characters. Copy it from the Web SDK application in the Duo Admin Panel.");
    patch.clientSecret = v;
  }
  if (body.api_host !== undefined) {
    const raw = String(body.api_host).trim();
    const host = raw ? normalizeDuoHost(raw) : "";
    if (host === null) return bad("The API hostname looks like api-xxxxxxxx.duosecurity.com. Enter the hostname only, without https://.");
    patch.apiHost = host;
  }
  if (body.username_source !== undefined) patch.usernameSource = body.username_source === "username" ? "username" : "email";
  if (body.desk_hours !== undefined) {
    const n = Number(body.desk_hours);
    if (!Number.isInteger(n) || n < DUO_DESK_HOURS_MIN || n > DUO_DESK_HOURS_MAX) {
      return bad(`Enter a whole number of hours from ${DUO_DESK_HOURS_MIN} to ${DUO_DESK_HOURS_MAX}.`);
    }
    patch.deskHours = n;
  }
  if (body.fail_open !== undefined) patch.failOpen = body.fail_open === true;
  if (body.bypass_user_ids !== undefined) {
    if (!Array.isArray(body.bypass_user_ids)) return bad("Invalid request.");
    const known = new Set((await listUsers()).filter((u) => u.status === "active").map((u) => u.id));
    const ids = [...new Set(body.bypass_user_ids.filter((n): n is number => Number.isSafeInteger(n)))];
    // An account that is already on the list stays even when it is disabled now; a new one must be an active account.
    if (ids.some((id) => !known.has(id) && !cur.bypassUserIds.includes(id))) return bad("One of those accounts no longer exists or is disabled.");
    if (ids.length > DUO_BYPASS_MAX) return bad(`The bypass list holds at most ${DUO_BYPASS_MAX} accounts.`);
    patch.bypassUserIds = ids;
  }

  const credentialsChanged =
    (patch.clientId !== undefined && patch.clientId !== cur.clientId) ||
    (patch.apiHost !== undefined && patch.apiHost !== cur.apiHost) ||
    (patch.clientSecret !== undefined && !(cur.clientSecret && sameText(patch.clientSecret, cur.clientSecret)));

  const wantSignIn = body.enforce_signin !== undefined ? body.enforce_signin === true : cur.enforceSignIn;
  const wantDesk = body.enforce_desk !== undefined ? body.enforce_desk === true : cur.enforceDesk;
  const turningOn = (wantSignIn && !cur.enforceSignIn) || (wantDesk && !cur.enforceDesk);
  const next: DuoSettings = {
    ...cur,
    clientId: patch.clientId ?? cur.clientId,
    clientSecret: patch.clientSecret ?? cur.clientSecret,
    apiHost: patch.apiHost ?? cur.apiHost,
  };

  if (turningOn) {
    // The lockout guard. Not with unsaved or untested credentials, and not on someone else's test.
    if (credentialsChanged || !duoConfigured(next)) {
      return bad("Save the Duo details and run Test with my account first. Then turn this on.");
    }
    if (!duoVerifiedBy(cur, sid, gate.id)) {
      return bad("Run Test with my account first. A rule can be turned on only after you have approved a Duo request yourself, in this session, with the details saved here.");
    }
  }
  // New credentials are untested: nothing may depend on them until they are.
  const rulesTurnedOff = credentialsChanged && (cur.enforceSignIn || cur.enforceDesk || wantSignIn || wantDesk);
  patch.enforceSignIn = credentialsChanged ? false : wantSignIn;
  patch.enforceDesk = credentialsChanged ? false : wantDesk;

  const keyErr = await credentialSaveError(() => saveDuoSettings(patch, { credentialsChanged }));
  if (keyErr) return keyErr;

  await audit({
    actor: actorFrom(gate),
    action: "settings.duo",
    // Never the secret: only that it changed.
    details: {
      api_host: next.apiHost,
      client_id_changed: patch.clientId !== undefined && patch.clientId !== cur.clientId,
      secret_changed: patch.clientSecret !== undefined && credentialsChanged,
      username_source: patch.usernameSource ?? cur.usernameSource,
      enforce_signin: patch.enforceSignIn,
      enforce_desk: patch.enforceDesk,
      desk_hours: patch.deskHours ?? cur.deskHours,
      fail_open: patch.failOpen ?? cur.failOpen,
      bypass_user_ids: patch.bypassUserIds ?? cur.bypassUserIds,
      ...(rulesTurnedOff ? { rules_turned_off: true } : {}),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, rules_turned_off: rulesTurnedOff, state: await duoView(gate.id, sid) });
}
