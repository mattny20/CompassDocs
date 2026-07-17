import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletterAppearance,
  saveNewsletterAppearance,
  EMAIL_WIDTH_MIN,
  EMAIL_WIDTH_MAX,
  TEXTURES,
  HEADER_PADS,
} from "@/lib/newsletter";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
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

  const patch: {
    width?: number;
    header_image?: string;
    header_scale?: number;
    header_pad?: number;
    header_bg?: string;
    body_bg?: string;
    body_texture?: string;
  } = {};
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
  if (body?.header_scale !== undefined) {
    const s = Number(body.header_scale);
    if (!Number.isInteger(s) || s < 20 || s > 100) {
      return NextResponse.json(
        { error: "Header scale must be a whole number between 20 and 100 percent." },
        { status: 400 }
      );
    }
    patch.header_scale = s;
  }
  if (body?.header_pad !== undefined) {
    const p = Number(body.header_pad);
    if (!(HEADER_PADS as readonly number[]).includes(p)) {
      return NextResponse.json(
        { error: `Header padding must be one of: ${HEADER_PADS.join(", ")} px.` },
        { status: 400 }
      );
    }
    patch.header_pad = p;
  }
  for (const key of ["header_bg", "body_bg"] as const) {
    if (body?.[key] !== undefined) {
      const v = String(body[key] ?? "").trim();
      if (v !== "" && !HEX_RE.test(v)) {
        return NextResponse.json(
          { error: "Colors must be 6-digit hex values like #1e3a5f." },
          { status: 400 }
        );
      }
      patch[key] = v.toLowerCase();
    }
  }
  if (body?.body_texture !== undefined) {
    const t = String(body.body_texture ?? "");
    if (!(TEXTURES as readonly string[]).includes(t)) {
      return NextResponse.json(
        { error: `Texture must be one of: ${TEXTURES.join(", ")}.` },
        { status: 400 }
      );
    }
    patch.body_texture = t;
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
