import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getLink, linkVisibleTo } from "@/lib/db";
import { uploadReadStream } from "@/lib/uploads";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Serve a quick link's cached favicon / custom icon. Signed-in only, and the
// link's group restriction applies (admins see everything).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const link = await getLink(Number(id));
  if (!link || !link.icon_file || !link.icon_mime) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (user.role !== "admin" && !(await linkVisibleTo(link.id, user.id))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const stream = uploadReadStream(link.icon_file);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": link.icon_mime,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
