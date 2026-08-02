import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getUserById, setUserProfile, setUserAvatar } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Client resizes to ~128px before upload; 150k chars ≈ 110 KB binary.
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX_CHARS = 150_000;

// Self-service profile: display name + email (local accounts only — SSO and
// SCIM keep the identity provider as the source of truth) and avatar (anyone).
export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer", "account.profile_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const me = await getUserById(user.id);
  if (!me) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const wantsIdentityChange = body?.name !== undefined || body?.email !== undefined;
  if (wantsIdentityChange) {
    if (me.auth_provider !== "local") {
      return NextResponse.json(
        { error: "Your name and email are managed by your identity provider." },
        { status: 403 }
      );
    }
    const name = typeof body?.name === "string" ? body.name.trim() : me.name;
    const email = typeof body?.email === "string" ? body.email.trim() : me.email;
    if (name.length === 0 || name.length > 80) {
      return NextResponse.json({ error: "Name must be 1–80 characters." }, { status: 400 });
    }
    if (email !== "" && (email.length > 200 || !EMAIL_RE.test(email))) {
      return NextResponse.json({ error: "That email address doesn't look valid." }, { status: 400 });
    }
    await setUserProfile(user.id, { name, email });
    await audit({
      actor: actorFrom(user),
      action: "account.profile_updated",
      details: { name_changed: name !== me.name, email_changed: email !== me.email },
      ip: ipFrom(req),
    });
  }

  if (body?.avatar !== undefined) {
    const avatar = typeof body.avatar === "string" ? body.avatar : "";
    if (avatar !== "" && (avatar.length > AVATAR_MAX_CHARS || !AVATAR_RE.test(avatar))) {
      return NextResponse.json(
        { error: "Avatar must be a small PNG, JPEG, or WebP image." },
        { status: 400 }
      );
    }
    await setUserAvatar(user.id, avatar);
  }

  return NextResponse.json({ ok: true });
}
