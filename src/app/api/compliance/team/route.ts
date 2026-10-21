import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listGroups, teamPolicyRows, leadMayRemind, stampAckReminded } from "@/lib/db";
import { userHolds } from "@/lib/access";
import { teamViewAccess, type TeamViewRow } from "@/lib/team-access";
import { enqueueAckNotice, sweepDefaults, workspaceDueDefaults } from "@/lib/compliance";
import { teamGroupSummaries, remindedAgoSentence, daysSince } from "@/lib/team-digest";
import { auditAck, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The team-lead view of policies (F4, 1.14.0): where the members of the
// groups this person leads stand on the policies that ask them, the policy
// twin of /api/training/team.
//
// Who may open it is lib/team-access's rule (one copy, shared with the
// section layout, the team page and the mine route): leading a group
// (group_leads) when Program settings let leads see policy standing, or
// compliance.team_read, which opens every group. The rows are scoped in SQL
// to the viewer's readable spaces (teamPolicyRows): a lead of a broad group
// reads "2 policies you can't view" as a count, never a private-space title.
//
// GET  → { groups: [{ id, name, members, confirmed, open, overdue }], rows: TeamViewRow[] }
//   each row with `may_remind`: whether POST would let this viewer remind it
//   (the viewer leads one of the member's groups, or holds
//   compliance.program_manage), so the page disables Remind where the POST
//   would answer 403 instead of offering a control that fails.
// POST { assignment_id } → one reminder for that person, queued through the
//   outbox as a manual reminder from the lead, stamped on the row, audited
//   ack.reminder_sent { by: 'lead', user_id }; governed by the row's own
//   reminded_at and the policy's remind_every_days (the cascade), not the
//   portal's per-document hour: 429 "{Name} was reminded {n} days ago."
//   inside the cadence. A lead reminds only members of groups they lead
//   (403 otherwise); a programme manager (compliance.program_manage) may
//   remind anyone the view shows, as the portal already lets them.

const NOT_YOUR_GROUP = "You can only remind members of groups you lead.";
const NO_ROW = "No such requirement.";

async function licence(): Promise<NextResponse | null> {
  if (await featureEnabled("policy_ack")) return null;
  return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
}

export async function GET() {
  // Authentication only at the guard: the decision below is either-or
  // (leadership or the permission), as the training route explains.
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const denied = await licence();
  if (denied) return denied;

  const access = await teamViewAccess(user.id);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: 403 });
  // A permission holder's view is built from the full group list, never by
  // passing "all" through the group filter (one way to express scope).
  const groups = access.every ? (await listGroups()).map((g) => ({ id: g.id, name: g.name })) : access.groups;
  const [rows, programManage] = await Promise.all([
    teamPolicyRows(
      groups.map((g) => g.id),
      user.id
    ),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
  ]);
  // may_remind, the POST's rule per row (leadMayRemind's `leads`: the member
  // is in a group this viewer leads; the rows list every member of every
  // group shown, so a member of a led group is found among them), or the
  // programme right. A lead sees only led groups, so every row is theirs.
  const led = new Set(access.groups.map((g) => g.id));
  const ledMembers = new Set(rows.filter((r) => led.has(r.group_id)).map((r) => r.user_id));
  const view: TeamViewRow[] = rows.map((r) => ({ ...r, may_remind: programManage || ledMembers.has(r.user_id) }));
  return NextResponse.json(
    { groups: teamGroupSummaries(groups, rows), rows: view },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const denied = await licence();
  if (denied) return denied;

  let body: { assignment_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const assignmentId = body?.assignment_id;
  if (!Number.isInteger(assignmentId) || (assignmentId as number) <= 0) {
    return NextResponse.json({ error: "Send the assignment_id of the row to remind." }, { status: 400 });
  }

  const access = await teamViewAccess(user.id);
  if (!access.allowed) return NextResponse.json({ error: access.reason }, { status: 403 });

  // The cadence resolves as the sweep resolves it: the policy's own number,
  // else the space's, else the workspace's, else the built-in 7.
  const defaults = sweepDefaults(await workspaceDueDefaults());
  const row = await leadMayRemind(assignmentId as number, user.id, defaults.remind_every_days);
  // A row in a space the viewer cannot read is absent, not forbidden.
  if (!row) return NextResponse.json({ error: NO_ROW }, { status: 404 });
  if (!row.leads && !(await userHolds(user, "compliance.program_manage", { legacyMin: "admin" }))) {
    return NextResponse.json({ error: NOT_YOUR_GROUP }, { status: 403 });
  }
  if (row.exempt) {
    return NextResponse.json({ error: `${row.user_name} is exempt from "${row.title}".` }, { status: 400 });
  }
  if (row.confirmed) {
    return NextResponse.json({ error: `${row.user_name} has already confirmed "${row.title}".` }, { status: 400 });
  }
  if (row.reminded_at) {
    const days = daysSince(row.reminded_at);
    if (days < row.remind_every_days) {
      return NextResponse.json(
        { error: remindedAgoSentence(row.user_name, days), days, remind_every_days: row.remind_every_days },
        { status: 429 }
      );
    }
  }

  // One 'reminder' row for this one person, as a manual notice from the
  // lead (delivered at once, never coalesced), then the row's stamp so the
  // cadence counts from now, then the audit row this route owns (the drain
  // writes its own ack.reminder_sent with the delivery counts).
  const sender = { id: user.id, name: user.name || user.username };
  const outboxId = await enqueueAckNotice(null, {
    document_id: row.document_id,
    mode: "reminder",
    source: "manual",
    actor: sender,
    user_ids: [row.user_id],
    origin: requestOrigin(req),
  });
  await stampAckReminded(row.document_id, [row.user_id]);
  await auditAck(
    "ack.reminder_sent",
    { id: row.document_id, title: row.title },
    {
      actor: actorFrom(user),
      ip: ipFrom(req),
      source: "manual",
      details: { by: "lead", user_id: row.user_id, assignment_id: row.assignment_id, outbox_id: outboxId, queued: 1 },
    }
  );
  return NextResponse.json({
    ok: true,
    queued: 1,
    outbox_id: outboxId,
    assignment_id: row.assignment_id,
    user_id: row.user_id,
    document_id: row.document_id,
  });
}
