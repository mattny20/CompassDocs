import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSetting, setSetting } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { newScimToken, hashScimToken } from "@/lib/scim";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Admin controls for SCIM provisioning: status, enable/disable, and bearer
// token generation. The raw token is returned exactly once; only its SHA-256
// is stored.

async function status(req: Request) {
  const [licensed, enabled, tokenHash, lastRequest] = await Promise.all([
    featureEnabled("scim"),
    getSetting("scim_enabled"),
    getSetting("scim_token_hash"),
    getSetting("scim_last_request_at"),
  ]);
  return {
    licensed,
    enabled: enabled === "1",
    token_set: Boolean(tokenHash),
    last_request_at: lastRequest || null,
    base_url: `${requestOrigin(req)}/api/scim/v2`,
  };
}

export async function GET(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await status(req));
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("scim"))) {
    return NextResponse.json(
      { error: "SCIM provisioning is not included in your license." },
      { status: 402 }
    );
  }

  const token = newScimToken();
  await setSetting("scim_token_hash", hashScimToken(token));
  await setSetting("scim_enabled", "1");
  await audit({
    actor: actorFrom(user),
    action: "scim.token_generated",
    ip: ipFrom(req),
  });
  // The raw token appears in this response only — never stored, never again.
  return NextResponse.json({ token, ...(await status(req)) });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  }
  await setSetting("scim_enabled", body.enabled ? "1" : "0");
  await audit({
    actor: actorFrom(user),
    action: body.enabled ? "scim.enabled" : "scim.disabled",
    ip: ipFrom(req),
  });
  return NextResponse.json(await status(req));
}
