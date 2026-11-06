// POST /api/helpdesk/attachments   multipart/form-data, field "file"
//   → 201 { attachment: HdAttachment } (unbound: name its id in the message
//   you post next, within a day). Size cap and type allowlist in
//   lib/helpdesk/attachments; images are identified by their bytes.
// Helpdesk 1.19.0 (helpdesk.request: requesters and agents). 30 a minute,
// and a per-person quota (UPLOAD_QUOTA): files not yet on a message are
// capped by count and bytes over the last day, and so is everything one
// person uploads in a day. Over the unbound quota, the person's own
// unbound uploads older than six hours (abandoned drafts) are removed
// first; still over, 429.

import { NextResponse } from "next/server";
import { helpdeskGate, tooMany, uploadLimited } from "@/lib/helpdesk/access";
import { ATTACHMENT_LIMITS, AttachmentRejectedError, saveHelpdeskAttachment, sweepUnboundAttachments } from "@/lib/helpdesk/attachments";
import { hq, hqOne } from "@/lib/helpdesk/db-core";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const MB = 1024 * 1024;

/** Per person, over the last 24 hours. */
const UPLOAD_QUOTA = {
  /** Uploads not yet attached to a message. */
  unboundFiles: 60,
  unboundBytes: 300 * MB,
  /** Everything uploaded, attached or not. */
  dailyFiles: 500,
  dailyBytes: 2048 * MB,
  /** Unbound uploads older than this are reclaimed when the person is over quota. */
  reclaimAfterMs: 6 * 3_600_000,
} as const;

interface Usage {
  unbound_files: number;
  unbound_bytes: number;
  daily_files: number;
  daily_bytes: number;
}

async function usageOf(userId: number): Promise<Usage> {
  const r = await hqOne<Usage>(
    `SELECT count(*) FILTER (WHERE message_id IS NULL)::int AS unbound_files,
            COALESCE(sum(size) FILTER (WHERE message_id IS NULL), 0)::float8 AS unbound_bytes,
            count(*)::int AS daily_files,
            COALESCE(sum(size), 0)::float8 AS daily_bytes
       FROM hd_attachments
      WHERE uploaded_by = $1 AND created_at > now() - interval '24 hours'`,
    [userId]
  );
  return r ?? { unbound_files: 0, unbound_bytes: 0, daily_files: 0, daily_bytes: 0 };
}

/** Null when `incoming` more bytes fit; otherwise the refusal. */
function overQuota(u: Usage, incoming: number): string | null {
  if (u.unbound_files + 1 > UPLOAD_QUOTA.unboundFiles || u.unbound_bytes + incoming > UPLOAD_QUOTA.unboundBytes) {
    return "You have too many files waiting to be sent. Send or remove them, or try again later.";
  }
  if (u.daily_files + 1 > UPLOAD_QUOTA.dailyFiles || u.daily_bytes + incoming > UPLOAD_QUOTA.dailyBytes) {
    return "You've reached today's upload limit. Try again tomorrow.";
  }
  return null;
}

/** The quota check, reclaiming the person's abandoned unbound uploads once when over. */
async function quotaRefusal(userId: number, incoming: number): Promise<string | null> {
  let usage = await usageOf(userId);
  let why = overQuota(usage, incoming);
  if (why && usage.unbound_files > 0) {
    const stale = await hq<{ id: number }>(
      "SELECT id FROM hd_attachments WHERE uploaded_by = $1 AND message_id IS NULL AND created_at < now() - make_interval(secs => $2)",
      [userId, UPLOAD_QUOTA.reclaimAfterMs / 1000]
    );
    if (stale.length) {
      await sweepUnboundAttachments(UPLOAD_QUOTA.reclaimAfterMs, stale.map((r) => Number(r.id)));
      usage = await usageOf(userId);
      why = overQuota(usage, incoming);
    }
  }
  return why;
}

const quotaResponse = (error: string) => NextResponse.json({ error }, { status: 429 });

export async function POST(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (uploadLimited(gate.id)) return tooMany();
  const len = Number(req.headers.get("content-length") || 0);
  if (len > ATTACHMENT_LIMITS.maxBytes + 64 * 1024) {
    return NextResponse.json({ error: `Files can be up to ${Math.round(ATTACHMENT_LIMITS.maxBytes / 1024 / 1024)} MB.` }, { status: 413 });
  }
  // Before the body is read: a person over quota costs no disk or memory.
  const early = await quotaRefusal(gate.id, 0);
  if (early) return quotaResponse(early);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Send the file as multipart form data.");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return badRequest("Choose a file.");
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const late = overQuota(await usageOf(gate.id), buf.length);
    if (late) return quotaResponse(late);
    const attachment = await saveHelpdeskAttachment({ buf, filename: file.name || "file", mime: file.type, userId: gate.id });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (e) {
    if (e instanceof AttachmentRejectedError) return NextResponse.json({ error: e.message }, { status: 415 });
    throw e;
  }
}
