import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletterAppearance,
  saveNewsletterAppearance,
  EMAIL_WIDTH_MIN,
  EMAIL_WIDTH_MAX,
} from "@/lib/newsletter";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Email appearance for newsletters: content width and an optional custom
// header banner (upload the image via /api/newsletter/assets first).

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getNewsletterAppearance());
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const patch: { width?: number; header_image?: string } = {};
  if (body?.width !== undefined) {
    const w = Number(body.width);
    if (!Number.isInteger(w) || w < EMAIL_WIDTH_MIN || w > EMAIL_WIDTH_MAX) {
      return NextResponse.json(
        { error: `Width must be a whole number between ${EMAIL_WIDTH_MIN} and ${EMAIL_WIDTH_MAX} pixels.` },
        { status: 400 }
      );
    }
    patch.width = w;
  }
  if (body?.header_image !== undefined) {
    const h = String(body.header_image ?? "").trim();
    // Only our own public assets (inboxes can load them) or an https URL.
    if (h !== "" && !h.startsWith("/api/newsletter/assets/") && !/^https:\/\//.test(h)) {
      return NextResponse.json(
        { error: "The header image must be an uploaded newsletter asset or an https URL." },
        { status: 400 }
      );
    }
    patch.header_image = h.slice(0, 500);
  }

  const saved = await saveNewsletterAppearance(patch);
  await audit({
    actor: actorFrom(admin),
    action: "newsletter.appearance_updated",
    targetType: "settings",
    targetLabel: "newsletter_appearance",
    details: { ...patch },
    ip: ipFrom(req),
  });
  return NextResponse.json(saved);
}
