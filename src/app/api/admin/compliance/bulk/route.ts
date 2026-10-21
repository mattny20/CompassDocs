import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import { BULK_IDS_MAX, BULK_PEOPLE_IDS, bulkPeoplePolicies, parseBulkRequest, runBulkAction } from "@/lib/ack-bulk";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Bulk actions across policies and people (F5, 1.14.0): the Policies bar
// ("{n} policies selected") and the People bar ("{n} people selected") of
// the compliance portal, and the record page's "Remind about everything
// outstanding", all through one endpoint that composes the programme's
// existing writes (lib/ack-bulk) and queues every notice as an outbox row:
// nothing in the request awaits a mailer or a webhook.
//
// POST { action, doc_ids?, user_ids?, assignment_ids?, params? }
//   action: remind | set_deadline | set_owner | set_reminders | reask |
//           add_to_set (over doc_ids, up to 200), or remind_people |
//           reask_people | exempt_people | extend_people (over user_ids, or
//           assignment_ids for the named rows only; exempt_people also takes
//           the doc_ids chosen; up to 200 each).
//   params: { days?, reason?, until?, owner_id?, set_id?, due_days?, due_at?,
//             move_existing?, remind_before_days?, remind_every_days?,
//             escalate_after_days?, nudge_every_days? }
//   → 200 { ok, action, done, queued, skipped: [{ id, title, reason }],
//           previous? (set_deadline / set_owner / set_reminders: each
//           policy's values before the write, for Undo), changed? (the
//           people actions: the assignment ids, for Undo on /assignments),
//           reset? (reask) }
//   → 400 naming the first problem (an unknown action, a reason under ten
//     characters, days outside 1..365, more than 200 ids, a deadline in the
//     past, an owner that is no account), 404 an unknown set, 409 a
//     deactivated set, 429 when every person named was asked again within
//     the hour (the dispatcher's per-person brake).
// GET ?user_ids=1,2,3 → { policies: [{ id, title, people, open, confirmed }] }:
//   the live policies the named people owe, for "Exempt from…".
//
// Guards: complianceGuard('compliance.program_manage') (the section, then
// the key: a program_read-only role is 403), then the licence (402). Audit:
// one summary row per call (ack.bulk_*) beside the per-policy and per-row
// rows the underlying writes emit.

async function gated(): Promise<{ denied: NextResponse } | { user: SessionUser }> {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) {
    return { denied: NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 }) };
  }
  return { user: gate };
}

export async function GET(req: Request) {
  const gate = await gated();
  if ("denied" in gate) return gate.denied;
  const raw = new URL(req.url).searchParams.get("user_ids") ?? "";
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return NextResponse.json({ error: BULK_PEOPLE_IDS }, { status: 400 });
    if (!ids.includes(n)) ids.push(n);
  }
  if (ids.length < 1 || ids.length > BULK_IDS_MAX) return NextResponse.json({ error: BULK_PEOPLE_IDS }, { status: 400 });
  return NextResponse.json({ policies: await bulkPeoplePolicies(ids) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await gated();
  if ("denied" in gate) return gate.denied;
  const { user } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseBulkRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const outcome = await runBulkAction(parsed.req, {
    // The outbox rows' and the assignment rows' actor: the same name the audit rows carry.
    actor: { id: user.id, name: user.name || user.username },
    audit: { actor: actorFrom(user), ip: ipFrom(req) },
    origin: requestOrigin(req),
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
