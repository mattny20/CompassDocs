import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getSignInText, saveSignInText } from "@/lib/sign-in-art";
import { parseSignInText, type SignInText } from "@/lib/sign-in-text";

export const dynamic = "force-dynamic";

// The sign-in page's text and layout choices (1.16.0, Settings → Workspace →
// Sign-in page): the headline, tagline and caption over the artwork, the
// help line and example email under the form, the focus point, the side and
// whether the name shows over a photo. Stored as plain settings outside
// AppSettings, so the workspace settings route and its allow-list are
// untouched. Text is normalised (lib/sign-in-text) and refused, never cut,
// when it runs over its limit.

export async function GET() {
  const gate = await apiGuard("admin", "workspace.branding_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getSignInText());
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin", "workspace.branding_manage");
  if (gate instanceof NextResponse) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { value, fields } = parseSignInText(body as Record<string, unknown>);
  if (Object.keys(fields).length > 0) {
    return NextResponse.json({ error: "Check the highlighted fields.", fields }, { status: 400 });
  }

  const before = await getSignInText();
  await saveSignInText(value);
  const changed = (Object.keys(value) as (keyof SignInText)[]).filter((k) => value[k] !== before[k]);
  if (changed.length > 0) {
    await audit({ actor: actorFrom(gate), action: "branding.sign_in_updated", details: { changed }, ip: ipFrom(req) });
  }
  return NextResponse.json({ ok: true, value });
}
