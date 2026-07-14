// Consent decision handler. Re-validates everything the consent page showed
// (the form fields are client-tamperable), then 303s back to the client's
// registered redirect URI with a single-use code — or error=access_denied.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createOAuthCode, getOAuthClient } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");

  const client = await getOAuthClient(get("client_id"));
  const redirectUri = get("redirect_uri");
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    return NextResponse.json({ error: "Invalid client or redirect URI." }, { status: 400 });
  }

  const target = new URL(redirectUri);
  const state = get("state");
  if (state) target.searchParams.set("state", state);

  if (get("decision") !== "approve") {
    target.searchParams.set("error", "access_denied");
    return NextResponse.redirect(target, 303);
  }

  const challenge = get("code_challenge");
  if (!challenge || (get("code_challenge_method") || "S256") !== "S256") {
    target.searchParams.set("error", "invalid_request");
    return NextResponse.redirect(target, 303);
  }

  const code = await createOAuthCode({
    clientId: client.client_id,
    userId: user.id,
    redirectUri,
    codeChallenge: challenge,
  });
  await audit({
    actor: actorFrom(user),
    action: "account.oauth_authorized",
    details: { client: client.name || client.client_id },
    ip: ipFrom(req),
  });

  target.searchParams.set("code", code);
  return NextResponse.redirect(target, 303);
}
