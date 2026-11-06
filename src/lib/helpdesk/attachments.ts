// Helpdesk 1.19.0: files on tickets (hd_attachments; the bytes live in the
// uploads volume, lib/uploads). Two ways in:
//
//   a person uploads first (POST /api/helpdesk/attachments: an UNBOUND row,
//     theirs), then posts the message naming the ids; the message route
//     trusts only rows pendingAttachments() returns (the uploader's own,
//     unbound, under a day old: never a client-sent name or size) and binds
//     them with attachToMessage() once the message exists;
//   inbound email saves with the ticket already known (ticketId), then binds
//     to the message it created.
//
// Limits: a size cap (COMPASSDOCS_HD_ATTACHMENT_MAX_MB, default 25 MB) and an
// extension allowlist (documents, images, archives, media; nothing a browser
// or an OS would run: no html, svg, scripts or executables). Images are
// identified by their bytes (sniffImage), never by the claimed type; every
// other file is stored and served as application/octet-stream with
// Content-Disposition: attachment. Unbound uploads older than a day go in
// the periodic sweep. Server-only.

import "server-only";
import { deleteUpload, safeExt, saveUpload, sniffImage } from "../uploads";
import { hq, hqOne } from "./db-core";
import type { HdAttachment } from "./types";

export class AttachmentRejectedError extends Error {}

export const ATTACHMENT_LIMITS = {
  /** Per file, bytes. */
  maxBytes: (Number(process.env.COMPASSDOCS_HD_ATTACHMENT_MAX_MB) || 25) * 1024 * 1024,
  perMessage: 10,
  filename: 200,
  /** Unbound uploads are claimable (and kept) for this long. */
  unboundMs: 24 * 3_600_000,
} as const;

/** Allowed extensions → the type a download is labelled with (images are sniffed instead). */
const ALLOWED: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".md": "text/plain",
  ".json": "application/json",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

interface Row {
  id: number | string;
  stored_name: string;
  filename: string;
  mime_type: string;
  size: number;
  ticket_id: number | null;
  message_id: number | null;
  uploaded_by: number | null;
  created_at: string;
}

const COLS = "id, stored_name, filename, mime_type, size, ticket_id, message_id, uploaded_by, created_at";

function toAttachment(r: Row): HdAttachment {
  return { id: Number(r.id), name: r.filename, size: r.size, type: r.mime_type };
}

/** A filename safe to keep and to put in a header (no path, no control characters). */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim();
  return (clean || "file").slice(0, ATTACHMENT_LIMITS.filename);
}

/**
 * Decide what to store: refuses an empty, oversized or disallowed file.
 * Pure (for tests): the stored type and extension.
 */
export function classifyUpload(buf: Buffer, filename: string): { mime: string; ext: string } {
  if (!buf.length) throw new AttachmentRejectedError("The file is empty.");
  if (buf.length > ATTACHMENT_LIMITS.maxBytes) {
    throw new AttachmentRejectedError(`Files can be up to ${Math.round(ATTACHMENT_LIMITS.maxBytes / 1024 / 1024)} MB.`);
  }
  const ext = safeExt(filename);
  const sniffed = sniffImage(buf);
  if (sniffed) return { mime: sniffed.mime, ext: sniffed.ext };
  if (!ext || !ALLOWED[ext]) throw new AttachmentRejectedError("That kind of file can't be attached.");
  // A file named like an image that is not one is stored as an opaque download.
  if (IMAGE_EXTS.has(ext)) return { mime: "application/octet-stream", ext };
  // Anything that looks like markup is refused whatever it is called.
  const head = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (/^(<!doctype html|<html|<svg|<\?xml|<script)/.test(head) && ext !== ".txt" && ext !== ".log" && ext !== ".md") {
    throw new AttachmentRejectedError("That kind of file can't be attached.");
  }
  return { mime: ALLOWED[ext], ext };
}

/** Store a file and its row. Unbound unless ticketId is given (inbound email). */
export async function saveHelpdeskAttachment(input: {
  buf: Buffer;
  filename: string;
  mime?: string;
  ticketId?: number | null;
  userId?: number | null;
}): Promise<HdAttachment> {
  const filename = cleanFilename(input.filename);
  const { mime, ext } = classifyUpload(input.buf, filename);
  const stored = await saveUpload(input.buf, ext);
  try {
    const row = await hqOne<Row>(
      `INSERT INTO hd_attachments (stored_name, filename, mime_type, size, ticket_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [stored, filename, mime, input.buf.length, input.ticketId ?? null, input.userId ?? null]
    );
    return toAttachment(row!);
  } catch (e) {
    await deleteUpload(stored);
    throw e;
  }
}

/**
 * The attachments a message may carry, as stored (never as the client
 * described them): each id must be the uploader's own unbound row under a
 * day old, or one already on this ticket and unbound (inbound email). Null
 * when any id fails, or there are too many.
 */
export async function pendingAttachments(
  ids: unknown,
  opts: { userId: number | null; ticketId: number }
): Promise<HdAttachment[] | null> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > ATTACHMENT_LIMITS.perMessage) return null;
  const want = [...new Set(ids.map((x) => Number(typeof x === "object" && x ? (x as { id?: unknown }).id : x)))];
  if (want.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  if (!want.length) return [];
  const rows = await hq<Row>(
    `SELECT ${COLS} FROM hd_attachments
      WHERE id = ANY($1::bigint[]) AND message_id IS NULL
        AND ((uploaded_by = $2 AND (ticket_id IS NULL OR ticket_id = $3) AND created_at > now() - make_interval(secs => $4))
             OR ($2::int IS NULL AND ticket_id = $3))`,
    [want, opts.userId, opts.ticketId, ATTACHMENT_LIMITS.unboundMs / 1000]
  );
  if (rows.length !== want.length) return null;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return want.map((id) => toAttachment(byId.get(id)!));
}

/**
 * Bind attachments to a posted message (and its ticket). Only rows that are
 * still unbound and either the uploader's (opts.userId) or already on this
 * ticket are bound. Returns the bound attachments.
 */
export async function attachToMessage(
  ids: number[],
  ticketId: number,
  messageId: number,
  opts: { userId?: number | null } = {}
): Promise<HdAttachment[]> {
  if (!ids.length) return [];
  const rows = await hq<Row>(
    `UPDATE hd_attachments SET ticket_id = $2, message_id = $3
      WHERE id = ANY($1::bigint[]) AND message_id IS NULL
        AND (ticket_id = $2 OR (ticket_id IS NULL AND uploaded_by IS NOT DISTINCT FROM $4::int AND $4::int IS NOT NULL))
      RETURNING ${COLS}`,
    [ids, ticketId, messageId, opts.userId ?? null]
  );
  return rows.map(toAttachment);
}

/** One attachment with what the download route needs to decide access. */
export async function getAttachmentForDownload(id: number): Promise<
  | (HdAttachment & {
      stored_name: string;
      ticket_id: number | null;
      message_id: number | null;
      uploaded_by: number | null;
      message_kind: string | null;
      /** The message's newbie review state: 'pending' or 'returned' means it was never sent (agents only). */
      message_review_state: string | null;
    })
  | undefined
> {
  const r = await hqOne<Row & { message_kind: string | null; message_review_state: string | null }>(
    `SELECT a.id, a.stored_name, a.filename, a.mime_type, a.size, a.ticket_id, a.message_id, a.uploaded_by, a.created_at,
            m.kind AS message_kind, m.review_state AS message_review_state
       FROM hd_attachments a LEFT JOIN hd_messages m ON m.id = a.message_id
      WHERE a.id = $1`,
    [id]
  );
  if (!r) return undefined;
  return {
    ...toAttachment(r),
    stored_name: r.stored_name,
    ticket_id: r.ticket_id,
    message_id: r.message_id,
    uploaded_by: r.uploaded_by,
    message_kind: r.message_kind,
    message_review_state: r.message_review_state,
  };
}

/** Delete a ticket's files (call before deleting the ticket; the rows cascade). */
export async function deleteTicketFiles(ticketId: number): Promise<number> {
  const rows = await hq<{ stored_name: string }>("DELETE FROM hd_attachments WHERE ticket_id = $1 RETURNING stored_name", [ticketId]);
  for (const r of rows) await deleteUpload(r.stored_name);
  return rows.length;
}

/** The sweep: unbound uploads older than a day, rows and files. `olderThanMs` for tests. */
export async function sweepUnboundAttachments(olderThanMs: number = ATTACHMENT_LIMITS.unboundMs, ids?: number[]): Promise<number> {
  const rows = await hq<{ stored_name: string }>(
    `DELETE FROM hd_attachments
      WHERE message_id IS NULL AND created_at < now() - make_interval(secs => $1)
        ${ids ? "AND id = ANY($2::bigint[])" : ""}
      RETURNING stored_name`,
    ids ? [olderThanMs / 1000, ids] : [olderThanMs / 1000]
  );
  for (const r of rows) await deleteUpload(r.stored_name);
  return rows.length;
}
