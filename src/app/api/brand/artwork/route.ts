import { NextResponse } from "next/server";
import { Readable } from "stream";
import { artFileFor } from "@/lib/sign-in-art";
import { uploadExists, uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

// The sign-in page's artwork (1.16.0, lib/sign-in-art). Public on purpose:
// it renders before sign-in. Only ever streams the re-encoded WebP files the
// artwork setting names (opaque random names in the uploads volume). Every
// upload changes ?v=, so a response may be cached for good.
export async function GET(req: Request) {
  const width = Number(new URL(req.url).searchParams.get("w")) || 1600;
  const file = await artFileFor(width);
  if (!file || !(await uploadExists(file))) {
    return NextResponse.json({ error: "No artwork set." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const stream = uploadReadStream(file);
  if (!stream) return NextResponse.json({ error: "No artwork set." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
