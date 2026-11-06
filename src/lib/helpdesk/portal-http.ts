// Helpdesk 1.19.1: request plumbing for the customer portal's routes
// (agent V6). The portal's API lives under /support/api, inside the path
// its cookie is scoped to; nothing under /api reads the portal cookie.
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { logEvent } from "../log";
import { PORTAL_FILE_LIMITS, PortalRefusal, type PortalFile } from "./portal";

/** JSON with no caching: portal answers are per contact. */
export function portalJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function refusalResponse(e: unknown): NextResponse {
  if (e instanceof PortalRefusal) return portalJson({ error: e.message }, e.status);
  logEvent("error", "helpdesk.portal_failed", { error: e instanceof Error ? e.message : String(e) });
  return portalJson({ error: "Something went wrong. Try again in a moment." }, 500);
}

/** A small JSON body, or null when it is not one or too big. */
export async function readSmallJson(req: Request, maxBytes = 8 * 1024): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Room for every file plus the form's text and the multipart envelope. */
const MAX_FORM_BYTES = PORTAL_FILE_LIMITS.perMessage * PORTAL_FILE_LIMITS.maxBytes + 1024 * 1024;

/**
 * A portal form (multipart: text fields and `files`), refused before it is
 * read when it does not state its size or states too much (the body is
 * buffered, so the declared length is the cap).
 */
export async function readPortalForm(req: Request): Promise<{ fields: Record<string, string>; files: PortalFile[] }> {
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) throw new PortalRefusal("The request must state its size.", 411);
  if (Number(declared) > MAX_FORM_BYTES) throw new PortalRefusal(`Attach up to ${PORTAL_FILE_LIMITS.perMessage} files of up to ${PORTAL_FILE_LIMITS.maxBytes / 1024 / 1024} MB each.`, 413);
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) throw new PortalRefusal("Send the form as it is.", 415);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new PortalRefusal("The form could not be read. Try again.");
  }
  const fields: Record<string, string> = {};
  const files: PortalFile[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      if (key in fields) continue;
      fields[key] = value.slice(0, 40_000);
    } else if (key === "files" && value.size > 0) {
      if (files.length >= PORTAL_FILE_LIMITS.perMessage) throw new PortalRefusal(`Attach up to ${PORTAL_FILE_LIMITS.perMessage} files at a time.`);
      if (value.size > PORTAL_FILE_LIMITS.maxBytes) throw new PortalRefusal(`“${value.name}” is too big. Files can be up to ${PORTAL_FILE_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
      files.push({ name: value.name || "file", buf: Buffer.from(await value.arrayBuffer()) });
    }
  }
  return { fields, files };
}

/** The request number in a route parameter, or null. */
export function portalNumber(raw: string): number | null {
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 2_000_000_000 ? n : null;
}
