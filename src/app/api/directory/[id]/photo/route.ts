import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { visiblePersonPhoto } from "@/lib/directory";

export const dynamic = "force-dynamic";

// Photos are stored as data: URLs on directory_people.photo. Serve the decoded
// bytes so a people typeahead can show avatars without inflating every JSON
// response by ~270 KB per person.
//
// Script-safety policy matches attachments and link icons: raster formats only,
// nosniff, and a locked-down CSP so nothing can execute even if the stored
// prefix lies about the payload.
const ALLOWED_MIME = /^image\/(png|jpeg|gif|webp)$/;
const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/;

/** A visible directory person's photo — any signed-in user. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const personId = Number(id);
  // visiblePersonPhoto enforces hidden = 0 and photo <> '' in SQL, so a hidden
  // person is indistinguishable from a missing one here.
  const row = Number.isInteger(personId) ? await visiblePersonPhoto(personId) : undefined;
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const parsed = DATA_URL.exec(row.photo);
  const mime = parsed?.[1].toLowerCase() ?? "";
  if (!parsed || !ALLOWED_MIME.test(mime)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const bytes = Buffer.from(parsed[2], "base64");
  if (bytes.length === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const etag = `W/"p${personId}-${Math.floor((Date.parse(row.updated_at) || 0) / 1000)}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, max-age=86400" },
    });
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      // Private: this is a signed-in-only resource, so no shared cache may
      // hold it. The ?v cache-buster on the URL changes when the photo does.
      "Cache-Control": "private, max-age=86400",
      ETag: etag,
    },
  });
}
