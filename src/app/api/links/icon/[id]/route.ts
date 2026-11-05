import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { getLink, linkIsPublicSignIn, linkVisibleTo } from "@/lib/db";
import { uploadReadStream } from "@/lib/uploads";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Serve a quick link's cached favicon / custom icon. Signed-in only, and the
// link's group restriction applies (admins see everything). The one public
// case (1.17.0): a link on the sign-in page — flagged and unrestricted — so
// the page can show its icon before anyone signs in. A restricted link's
// icon is never served without a session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const linkId = Number(id);
  let publicIcon = false;

  if (!(await getCurrentUser())) {
    if (!Number.isInteger(linkId) || !(await linkIsPublicSignIn(linkId))) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    publicIcon = true;
  } else {
    const gate = await apiGuard("viewer", "link.icon_read");
    if (gate instanceof NextResponse) return gate;
    const user = gate as SessionUser;
    if (user.role !== "admin" && Number.isInteger(linkId) && !(await linkVisibleTo(linkId, user.id))) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  }

  const link = Number.isInteger(linkId) ? await getLink(linkId) : undefined;
  if (!link || !link.icon_file || !link.icon_mime) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const stream = uploadReadStream(link.icon_file);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": link.icon_mime,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      // A public icon may stop being public (the flag cleared, a group
      // added): keep it out of shared caches and short in the browser's.
      "Cache-Control": publicIcon ? "private, max-age=3600" : "private, max-age=86400",
    },
  });
}
