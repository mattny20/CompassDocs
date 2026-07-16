import { NextResponse } from "next/server";
import { Readable } from "stream";
import { uploadReadStream, uploadExists, isValidStoredName } from "@/lib/uploads";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Serve a newsletter image. Deliberately public: recipients' mail clients
// fetch these with no session. Names are 128-bit random (unguessable), only
// whitelisted raster image extensions are ever written by the upload route,
// and anything else 404s.
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!isValidStoredName(name)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const ext = /\.[a-z0-9]{1,12}$/.exec(name)?.[0] ?? "";
  const mime = MIME_BY_EXT[ext];
  if (!mime) return NextResponse.json({ error: "Not found." }, { status: 404 });

  if (!(await uploadExists(name))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const stream = uploadReadStream(name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      // Content-addressed-ish (random immutable names): cache hard.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
