import "server-only";

// Getting a picture into a document, by every route that isn't "the model
// types out the bytes" (1.1).
//
// `add_image` originally took one thing: `data`, the whole image base64-encoded
// inside a tool-call argument. That fails two independent ways.
//
//   Size. Base64 inflates by a third, so a 300 KB screenshot is ~400,000
//   characters in a single argument. Clients cap tool input well below that —
//   a 10,000-character cap allows 7.3 KB, which is a favicon.
//
//   Provenance, which is worse. A screenshot pasted into a conversation
//   reaches the model as vision input. There is no byte-level representation
//   for it to re-emit, so for the most common request of all the argument
//   cannot be filled correctly at any size. That is why the failures look
//   arbitrary: sometimes a refusal, sometimes plausible-looking base64 that
//   fails the sniff below.
//
// The fix is to stop routing bytes through the model. This module holds the
// three server-side intakes — decode, fetch, copy — behind one validator, so
// every path applies the same type sniff, the same size cap, and produces the
// same attachment.

import { createAttachment, getAttachment } from "./db";
import { getAppSettings } from "./settings-store";
import { saveUpload, sniffImage, uploadReadStream } from "./uploads";
import { safeFetch } from "./safe-fetch";

/** Everything an intake needs to produce, or the reason it couldn't. */
export type IntakeResult =
  | { ok: true; buf: Buffer; kind: { mime: string; ext: string } }
  | { ok: false; error: string };

/**
 * The one validator every intake passes through.
 *
 * The bytes decide the type — filenames and Content-Type headers lie, and this
 * is the check that stops a .png that is really an HTML error page. Image-only
 * on purpose: this is the screenshot path, not a general file uploader, and
 * only these four are served inline by /api/attachments.
 */
export async function validateImage(buf: Buffer): Promise<IntakeResult> {
  const kind = sniffImage(buf);
  if (!kind) {
    return {
      ok: false,
      error:
        "That doesn't look like a supported image. PNG, JPEG, GIF, and WebP are accepted (SVG is not). " +
        "If you fetched it from a URL, the server may have returned an error page instead of the file.",
    };
  }
  const { max_attachment_mb } = await getAppSettings();
  if (buf.length > max_attachment_mb * 1024 * 1024) {
    return {
      ok: false,
      error: `Image is ${(buf.length / 1024 / 1024).toFixed(1)} MB, over the ${max_attachment_mb} MB attachment limit for this workspace.`,
    };
  }
  return { ok: true, buf, kind };
}

/** Intake 1: base64 in the tool argument. Kept for small images. */
export async function intakeFromBase64(raw: string): Promise<IntakeResult> {
  let b64 = String(raw ?? "").trim();
  const dataUri = b64.match(/^data:[^;,]*;base64,(.*)$/s);
  if (dataUri) b64 = dataUri[1];
  b64 = b64.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/=_-]+$/.test(b64)) {
    return {
      ok: false,
      error:
        "`data` must be the image bytes, base64-encoded. If you are working from a picture in the " +
        "conversation rather than a file you can read, you cannot produce those bytes — use " +
        "`source_url` if it has an address, or `request_upload` to hand the person a drop link.",
    };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, error: "`data` is not valid base64." };
  }
  return validateImage(buf);
}

/**
 * Intake 2: the server fetches it. The bytes never enter the model's context,
 * so size stops mattering.
 *
 * Through safeFetch, which is the SSRF guard the rest of the app already uses:
 * public targets only, redirects re-validated per hop. An MCP caller is a
 * semi-trusted principal handing us a URL, which is exactly the shape that
 * turns a fetcher into a port scanner without it.
 */
export async function intakeFromUrl(rawUrl: string): Promise<IntakeResult> {
  const url = String(rawUrl ?? "").trim();
  if (!url) return { ok: false, error: "`source_url` is empty." };

  const { max_attachment_mb } = await getAppSettings();
  const cap = max_attachment_mb * 1024 * 1024;

  let res: Response;
  try {
    res = await safeFetch(url, {
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // safeFetch throws for private/blocked targets too — say so plainly rather
    // than leaking whether the host resolved.
    return {
      ok: false,
      error: `Couldn't fetch that URL: ${e instanceof Error ? e.message : "request failed"}. It must be a public https address that returns the image directly.`,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `That URL returned ${res.status}. It must return the image file itself, not a page that displays it.` };
  }

  // Trust the declared length only to refuse early — a lying header must not
  // let a large body through, so the real check is on what actually arrived.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > cap) {
    return { ok: false, error: `That image is ${(declared / 1024 / 1024).toFixed(1)} MB, over the ${max_attachment_mb} MB limit.` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return validateImage(buf);
}

/**
 * Intake 3: an image already in this workspace, copied onto another document.
 *
 * Copies the bytes rather than sharing the stored file, so deleting the
 * original attachment can't blank an image on an unrelated document. Disk is
 * cheaper than that surprise.
 *
 * NOTE: the caller must have already checked that the SOURCE document is
 * readable. This function deliberately takes no scope of its own — passing an
 * unchecked attachment id here would read across spaces.
 */
export async function intakeFromAttachment(attachmentId: number): Promise<IntakeResult> {
  const att = await getAttachment(attachmentId);
  if (!att) return { ok: false, error: `No attachment with id ${attachmentId}.` };
  const stream = uploadReadStream(att.stored_name);
  if (!stream) return { ok: false, error: "That attachment's file is missing from storage." };
  const chunks: Buffer[] = [];
  try {
    for await (const c of stream) chunks.push(c as Buffer);
  } catch {
    return { ok: false, error: "Couldn't read that attachment's file." };
  }
  return validateImage(Buffer.concat(chunks));
}

/** Persist a validated image against a document and return the attachment. */
export async function storeImage(opts: {
  documentId: number;
  userId: number;
  buf: Buffer;
  kind: { mime: string; ext: string };
  filename?: string;
}) {
  const requested = String(opts.filename ?? "").trim();
  const filename = (
    requested
      ? requested.toLowerCase().endsWith(opts.kind.ext)
        ? requested
        : requested + opts.kind.ext
      : `image${opts.kind.ext}`
  ).slice(0, 255);
  const stored = await saveUpload(opts.buf, opts.kind.ext);
  return createAttachment({
    document_id: opts.documentId,
    filename,
    stored_name: stored,
    mime_type: opts.kind.mime,
    size: opts.buf.length,
    created_by: opts.userId,
  });
}

/** How a freshly-attached image should be placed in the document body. */
export type InsertMode = "none" | "append" | "top";

export function isInsertMode(v: unknown): v is InsertMode {
  return v === "none" || v === "append" || v === "top";
}

/**
 * Put the markdown in the document.
 *
 * Uploading and placing used to be two calls, and the tool's own description
 * had to warn that "uploading alone does not display it" — a second step that
 * gets skipped, or done with a full-body rewrite that clobbers concurrent
 * edits. This appends or prepends and touches nothing else.
 */
export function withImagePlaced(
  content: string,
  markdown: string,
  mode: InsertMode
): string {
  if (mode === "none") return content;
  const body = content ?? "";
  if (mode === "top") return `${markdown}\n\n${body}`;
  return body.trimEnd() ? `${body.trimEnd()}\n\n${markdown}\n` : `${markdown}\n`;
}

// --- Upload tickets: the handoff for a picture only a human can produce -----

import { randomBytes } from "crypto";
import { pool } from "./db";

export interface ImageUploadTicket {
  id: number;
  token: string;
  document_id: number;
  created_by: number;
  insert_mode: InsertMode;
  alt: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  attachment_id: number | null;
}

/** How long a drop link stays good. Long enough to walk away and come back. */
const TICKET_TTL_MINUTES = 60;

/** Mint a single-use drop link for one document. */
export async function createUploadTicket(opts: {
  documentId: number;
  userId: number;
  insert: InsertMode;
  alt?: string;
}): Promise<ImageUploadTicket> {
  const token = randomBytes(24).toString("base64url");
  const { rows } = await pool().query<ImageUploadTicket>(
    `INSERT INTO image_upload_tickets (token, document_id, created_by, insert_mode, alt, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int))
     RETURNING *`,
    [token, opts.documentId, opts.userId, opts.insert, (opts.alt ?? "").slice(0, 300), TICKET_TTL_MINUTES]
  );
  return rows[0];
}

/** Read a ticket for display, without consuming it. */
export async function getUploadTicket(token: string): Promise<ImageUploadTicket | undefined> {
  const { rows } = await pool().query<ImageUploadTicket>(
    "SELECT * FROM image_upload_tickets WHERE token = $1",
    [String(token ?? "")]
  );
  return rows[0];
}

export type TicketState = "ok" | "unknown" | "expired" | "used";

export function ticketState(t: ImageUploadTicket | undefined): TicketState {
  if (!t) return "unknown";
  if (t.used_at) return "used";
  if (new Date(t.expires_at).getTime() <= Date.now()) return "expired";
  return "ok";
}

/**
 * Claim a ticket, atomically.
 *
 * The UPDATE is the lock: `used_at IS NULL` in the WHERE means two
 * simultaneous drops can't both win, and whoever loses gets `undefined` rather
 * than a second attachment. Expiry is checked in the same statement so a
 * ticket can't go stale between the check and the claim.
 */
export async function claimUploadTicket(
  token: string,
  attachmentId: number
): Promise<ImageUploadTicket | undefined> {
  const { rows } = await pool().query<ImageUploadTicket>(
    `UPDATE image_upload_tickets
        SET used_at = now(), attachment_id = $2
      WHERE token = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING *`,
    [String(token ?? ""), attachmentId]
  );
  return rows[0];
}
