import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { setAnnouncementArchived, deleteAnnouncement } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Archive / unarchive: hides the message from every dashboard, reversibly.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await sectionApiGuard("announcements");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.archived !== "boolean") {
    return NextResponse.json({ error: "archived must be true or false." }, { status: 400 });
  }
  const ok = await setAnnouncementArchived(Number(id), body.archived);
  if (!ok) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: body.archived ? "announcement.archived" : "announcement.unarchived",
    targetType: "announcement",
    targetId: Number(id),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await sectionApiGuard("announcements");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const ok = await deleteAnnouncement(Number(id));
  if (!ok) return NextResponse.json({ error: "Announcement not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "announcement.deleted",
    targetType: "announcement",
    targetId: Number(id),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}
