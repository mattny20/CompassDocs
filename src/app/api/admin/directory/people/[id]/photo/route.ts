// An admin's photo for a person: any raster image, cropped square and
// stored as the 48px thumbnail every row carries plus the 240px copy the
// profile and contact card use. A synced person keeps this until the
// provider sends a photo of its own.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getPersonById, setPersonPhoto } from "@/lib/directory";
import { normalizePhoto } from "@/lib/directory-photos";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 6 * 1024 * 1024;

async function personFrom(ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) ? await getPersonById(id) : undefined;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;
  const person = await personFrom(ctx);
  if (!person) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let bytes: Buffer | null = null;
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("photo");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      if (file.size > MAX_BYTES) return NextResponse.json({ error: "That image is over 6 MB." }, { status: 413 });
      bytes = Buffer.from(await file.arrayBuffer());
    }
  } else {
    const body = await req.json().catch(() => null);
    if (typeof body?.photo === "string") bytes = Buffer.from(body.photo.replace(/^data:[^,]+,/, ""), "base64");
  }
  if (!bytes || bytes.length === 0) return NextResponse.json({ error: "Send an image as the photo field." }, { status: 400 });
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: "That image is over 6 MB." }, { status: 413 });

  const photos = await normalizePhoto(bytes);
  if (!photos) return NextResponse.json({ error: "That is not a PNG, JPEG, GIF or WebP image." }, { status: 400 });
  await setPersonPhoto(person.id, photos);
  await audit({
    actor: actorFrom(gate),
    action: "directory.photo_set",
    targetType: "directory_person",
    targetId: String(person.id),
    targetLabel: person.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, photo: photos.thumb });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "directory.person_manage");
  if (gate instanceof NextResponse) return gate;
  const person = await personFrom(ctx);
  if (!person) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await setPersonPhoto(person.id, null);
  await audit({
    actor: actorFrom(gate),
    action: "directory.photo_cleared",
    targetType: "directory_person",
    targetId: String(person.id),
    targetLabel: person.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
