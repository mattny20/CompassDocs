// GET /api/helpdesk/appearance/art/[id]?w=1920 → the WebP. Desk background artwork
// (1.19.4, lib/helpdesk/appearance): only for people the desk admits, and an agent's own
// upload only for them (anyone else gets the same 404 as a missing one, an id past the
// integer range included). Only ever streams the re-encoded copies the row names.
//
// Caching. A library picture never changes under its id, so it is cached privately for good.
// An agent's own picture is revalidated on every use (`private, no-cache` with an ETag, 304
// when unchanged), so the owner check runs each time: another account signed in later in the
// same browser can't be served it from the cache (review C5 finding 5).

import { NextResponse } from "next/server";
import { Readable } from "stream";
import { artFileFor } from "@/lib/helpdesk/appearance";
import { deskUserGate } from "@/lib/helpdesk/appearance-http";
import { uploadExists, uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await deskUserGate();
  if (gate instanceof NextResponse) return gate;
  const width = Number(new URL(req.url).searchParams.get("w")) || 1920;
  const raw = (await params).id;
  const found = /^\d{1,10}$/.test(raw) ? await artFileFor(Number(raw), width, gate.id) : null;
  if (!found || !(await uploadExists(found.file))) return NOT_FOUND();
  // The stored name is random and changes with every upload: a strong validator.
  const etag = `"${found.file}"`;
  const headers: Record<string, string> = {
    "Content-Type": "image/webp",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": found.own ? "private, no-cache" : "private, max-age=31536000, immutable",
    ETag: etag,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const stream = uploadReadStream(found.file);
  if (!stream) return NOT_FOUND();
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { headers });
}
