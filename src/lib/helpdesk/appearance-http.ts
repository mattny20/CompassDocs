import "server-only";

// Helpdesk 1.19.4: what the desk background routes share (lib/helpdesk/
// appearance). deskUserGate admits anyone the desk itself admits (an
// agent, a helpdesk admin or a reports reader, licensed), the same answer
// the desk's layout gets from helpdeskCapabilities. readArtUpload reads one
// multipart file with the sign-in artwork's rules: the declared length is
// the cap (a chunked body is refused before a byte is read), then the type
// from the bytes.

import { NextResponse } from "next/server";
import { crossOriginRejection } from "../api-auth";
import { getCurrentUser } from "../auth";
import { deskArtUploadRateLimited } from "../rate-limit";
import type { SessionUser } from "../types";
import { helpdeskCapabilities, HD_LICENCE_ERROR } from "./access";
import { DeskArtError, HD_ART_MAX_BYTES } from "./appearance-shared";

/** Signed in (401), licensed (402), any desk permission (403). Same-origin for writes. */
export async function deskUserGate(opts: { write?: boolean } = {}): Promise<SessionUser | NextResponse> {
  if (opts.write) {
    const cross = await crossOriginRejection();
    if (cross) return cross;
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  let caps: Awaited<ReturnType<typeof helpdeskCapabilities>>;
  try {
    caps = await helpdeskCapabilities(user);
  } catch {
    return NextResponse.json({ error: "Could not evaluate permissions. Try again shortly." }, { status: 503 });
  }
  if (!caps.licensed) return NextResponse.json({ error: HD_LICENCE_ERROR }, { status: 402 });
  if (!(caps.agent || caps.admin || caps.reports)) return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
  return user;
}

/** The body may carry the multipart envelope on top of the file itself. */
const MAX_BODY = HD_ART_MAX_BYTES + 512 * 1024;

/** One uploaded picture, or the response refusing it. */
export async function readArtUpload(req: Request, userId: number): Promise<{ buf: Buffer; filename: string } | NextResponse> {
  if (deskArtUploadRateLimited(String(userId))) {
    return NextResponse.json({ error: "Too many uploads. Try again in an hour." }, { status: 429 });
  }
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) {
    return NextResponse.json({ error: "The request must state its size (a Content-Length header)." }, { status: 411 });
  }
  if (Number(declared) > MAX_BODY) return NextResponse.json({ error: "Artwork is limited to 8 MB." }, { status: 413 });
  if (!(req.headers.get("content-type") || "").includes("multipart/form-data")) {
    return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size > HD_ART_MAX_BYTES) return NextResponse.json({ error: "Artwork is limited to 8 MB." }, { status: 413 });
  return { buf: Buffer.from(await file.arrayBuffer()), filename: file.name };
}

/** A DeskArtError as its response; anything else is rethrown. */
export function artErrorResponse(e: unknown): NextResponse {
  if (e instanceof DeskArtError) {
    return NextResponse.json({ error: e.message }, { status: e.status, headers: e.status === 503 ? { "Retry-After": "30" } : undefined });
  }
  throw e;
}
