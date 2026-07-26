import { NextResponse } from "next/server";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { getChatAskConfig, setChatAskConfig } from "@/lib/chat-ask";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Ask-in-chat (Slack / Teams) settings. Secrets are write-only: GET reports
// only whether one is stored.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getChatAskConfig());
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const err = await credentialSaveError(() =>
    setChatAskConfig({
      slack_enabled: typeof body?.slack_enabled === "boolean" ? body.slack_enabled : undefined,
      slack_signing_secret:
        typeof body?.slack_signing_secret === "string" ? body.slack_signing_secret : undefined,
      teams_enabled: typeof body?.teams_enabled === "boolean" ? body.teams_enabled : undefined,
      teams_hmac_secret:
        typeof body?.teams_hmac_secret === "string" ? body.teams_hmac_secret : undefined,
    })
  );
  if (err) return err;

  await audit({
    actor: actorFrom(gate),
    action: "settings.chat_ask",
    targetType: "settings",
    details: {
      fields: ["slack_enabled", "slack_signing_secret", "teams_enabled", "teams_hmac_secret"].filter(
        (k) => body?.[k] !== undefined
      ),
    },
    ip: ipFrom(req),
  });

  return NextResponse.json(await getChatAskConfig());
}
