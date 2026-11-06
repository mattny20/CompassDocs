// GET  /api/helpdesk/tickets?view=&team=&priority=&assignee=&status=&q=&sort=&limit=&offset=
//        the desk's queue in the caller's scope → { tickets: HdTicketListRow[], total }
//        view: mine|unassigned|open|overdue|workflow|waiting|solved_week|team:<id>|all
//          (default open; a search, q, without a view looks through every status)
//        assignee: <user id>|me|none · requester: <user id> · requester_email
//        sort: updated|created|due|priority|number
//        Report drill-downs (lib/helpdesk/analytics drillHref): request_type=<id>,
//        channel=<channel or source>, tag, category, department, office,
//        origin=people|automated, vip=yes|no, integration=<id>|none,
//        status_group=open, breached=1|now,
//        created_from/created_to, solved_from/solved_to (YYYY-MM-DD, inclusive).
// POST /api/helpdesk/tickets  { subject, body?, requester_id?, request_type_id?, answers?, team_id?,
//        assignee_id?, priority?, category?, tags?, first_message_kind?, attachments? }
//        an agent's ticket on someone's behalf (source 'desk') → 201 { ticket }
// Helpdesk 1.19.0 (helpdesk.agent).

import { NextResponse } from "next/server";
import { agentTeamIds, helpdeskGate, readJson, requestCreateLimited, tooMany } from "@/lib/helpdesk/access";
import {
  channelSources,
  cleanTicketTags,
  createTicket,
  isPriorityValue,
  isStatus,
  listTickets,
  parseView,
  TICKET_LIMITS,
} from "@/lib/helpdesk/tickets";
import type { TicketListFilters } from "@/lib/helpdesk/tickets";
import { getRequestType, validateAnswers } from "@/lib/helpdesk/request-types";
import { attachToMessage, pendingAttachments } from "@/lib/helpdesk/attachments";
import { badRequest, originOf, textField } from "@/lib/helpdesk/routes";
import { hq, hqOne } from "@/lib/helpdesk/db-core";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import type { HdFormAnswers, HdTicketSort } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

const SORTS: HdTicketSort[] = ["updated", "created", "due", "priority", "number"];

export async function GET(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = new URL(req.url).searchParams;
  const f: TicketListFilters = {};
  const view = parseView(p.get("view"));
  if (p.get("view") && !view) return badRequest("Unknown view.");
  if (view) f.view = view;
  const team = Number(p.get("team"));
  if (p.get("team")) {
    if (!Number.isInteger(team) || team <= 0) return badRequest("Unknown team.");
    f.team_id = team;
  }
  const pri = p.get("priority");
  if (pri) {
    if (!isPriorityValue(pri)) return badRequest("Unknown priority.");
    f.priority = pri;
  }
  const st = p.get("status");
  if (st) {
    if (!isStatus(st)) return badRequest("Unknown status.");
    f.status = st;
  }
  const a = p.get("assignee");
  if (a) {
    if (a === "me" || a === "none") f.assignee = a;
    else if (Number.isInteger(Number(a)) && Number(a) > 0) f.assignee = Number(a);
    else return badRequest("Unknown assignee.");
  }
  const rq = p.get("requester");
  if (rq) {
    if (!Number.isInteger(Number(rq)) || Number(rq) <= 0) return badRequest("Unknown requester.");
    f.requester_id = Number(rq);
  }
  const rem = p.get("requester_email");
  if (rem) {
    if (rem.length > 320 || !rem.includes("@")) return badRequest("Unknown requester.");
    f.requester_email = rem;
  }
  const rt = p.get("request_type");
  if (rt) {
    if (!Number.isInteger(Number(rt)) || Number(rt) <= 0) return badRequest("Unknown request type.");
    f.request_type_id = Number(rt);
  }
  const ch = p.get("channel");
  if (ch) {
    const sources = channelSources(ch);
    if (!sources) return badRequest("Unknown channel.");
    f.sources = sources;
  }
  for (const k of ["tag", "category", "department", "office"] as const) {
    const v = p.get(k);
    if (v === null) continue;
    if (v.length > 80) return badRequest(`The ${k} is too long.`);
    // "none" is Reports' key for an empty value.
    if (k === "tag") {
      if (v && v !== "none") f.tag = v;
    } else f[k] = v === "none" ? "" : v;
  }
  const origin = p.get("origin");
  if (origin) {
    if (origin !== "people" && origin !== "automated") return badRequest("Unknown origin.");
    f.origin = origin;
  }
  const vip = p.get("vip");
  if (vip) {
    if (vip !== "yes" && vip !== "no") return badRequest("vip is yes or no.");
    f.vip = vip;
  }
  const integ = p.get("integration");
  if (integ) {
    if (integ === "none") f.integration_id = "none";
    else if (Number.isInteger(Number(integ)) && Number(integ) > 0) f.integration_id = Number(integ);
    else return badRequest("Unknown integration.");
  }
  const sg = p.get("status_group");
  if (sg) {
    if (sg !== "open") return badRequest("Unknown status group.");
    f.status_group = "open";
  }
  const br = p.get("breached");
  if (br) {
    if (br !== "1" && br !== "now") return badRequest("breached is 1 or now.");
    f.breached = br === "now" ? "now" : "ever";
  }
  for (const k of ["created_from", "created_to", "solved_from", "solved_to"] as const) {
    const v = p.get(k);
    if (!v) continue;
    const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
    // A real calendar day (2026-02-31 does not round-trip), so Postgres never sees a bad date.
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return badRequest(`${k} is a date (YYYY-MM-DD).`);
    f[k] = v;
  }
  const sort = p.get("sort") as HdTicketSort | null;
  if (sort) {
    if (!SORTS.includes(sort)) return badRequest("Unknown sort.");
    f.sort = sort;
  }
  f.q = (p.get("q") ?? "").slice(0, TICKET_LIMITS.q);
  f.limit = Number(p.get("limit")) || 50;
  f.offset = Number(p.get("offset")) || 0;
  const { rows, total } = await listTickets(gate, f);
  return NextResponse.json({ tickets: rows, total });
}

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (requestCreateLimited(gate.id)) return tooMany();
  const b = await readJson(req, 256 * 1024);
  if (!b) return badRequest("Send the ticket as JSON.");
  let subject = textField(b.subject, TICKET_LIMITS.subject);
  if (subject === null) return badRequest(`Keep the subject under ${TICKET_LIMITS.subject} characters.`);
  const body = textField(b.body, TICKET_LIMITS.body);
  if (body === null) return badRequest("The description is too long.");

  // Who it is for: an active account (default: the agent).
  let requester = { id: gate.id as number | null, name: gate.name || gate.username, email: gate.email };
  if (b.requester_id !== undefined && b.requester_id !== null) {
    const u = await hqOne<{ id: number; name: string; username: string; email: string }>(
      "SELECT id, name, username, email FROM users WHERE id = $1 AND status = 'active'",
      [Number(b.requester_id)]
    );
    if (!u) return badRequest("That person has no active account.");
    requester = { id: u.id, name: u.name || u.username, email: u.email };
  }

  const teams = await agentTeamIds(gate);
  let teamId: number | null | undefined;
  if (b.team_id !== undefined) {
    teamId = b.team_id === null ? null : Number(b.team_id);
    if (teamId !== null) {
      if (!Number.isInteger(teamId) || !(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [teamId]))) return badRequest("Unknown team.");
    }
  }

  let requestTypeId: number | null = null;
  let answers: HdFormAnswers = {};
  if (b.request_type_id !== undefined && b.request_type_id !== null) {
    requestTypeId = Number(b.request_type_id);
    const rt = Number.isInteger(requestTypeId) ? await getRequestType(requestTypeId) : undefined;
    if (!rt) return badRequest("Unknown request type.");
    const checked = await validateAnswers(rt.form, b.answers ?? {});
    if (!checked.ok) return badRequest(checked.error);
    answers = checked.value;
    if (!subject) subject = rt.title;
    if (teamId === undefined) teamId = rt.team_id;
  }
  if (!subject) return badRequest("A ticket needs a subject.");
  // An agent files into the teams they work (agent_all: any).
  if (teams !== "all" && teamId != null && !teams.includes(teamId)) {
    return NextResponse.json({ error: "You can only open tickets for your own teams." }, { status: 403 });
  }
  if (teams !== "all" && teamId == null && teams.length === 1) teamId = teams[0];
  // Desk roles: filing for a team is seeing its queue.
  const seesAll = await hdCan(gate, "tickets.view_all");
  if (teamId == null && !seesAll) return badRequest("Choose the team this ticket is for.");
  if (!seesAll && !(await hdCan(gate, "tickets.view_team", { teamId }))) {
    return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  }

  const priority = b.priority === undefined ? undefined : b.priority;
  if (priority !== undefined && !isPriorityValue(priority)) return badRequest("Unknown priority.");
  const tags = b.tags === undefined ? [] : cleanTicketTags(b.tags);
  if (!tags) return badRequest("Up to 20 short tags.");
  const category = textField(b.category, TICKET_LIMITS.category);
  if (category === null) return badRequest("The category is too long.");
  const kind = b.first_message_kind === "internal" ? "internal" : "public";

  let assigneeId: number | null = null;
  if (b.assignee_id !== undefined && b.assignee_id !== null) {
    assigneeId = Number(b.assignee_id);
    const { assignable } = await import("@/lib/helpdesk/tickets");
    if (!Number.isInteger(assigneeId) || !(await assignable(assigneeId, teamId ?? null))) {
      return badRequest("That person is not an agent of this ticket's team.");
    }
  }
  const attachments = await pendingAttachments(b.attachments, { userId: gate.id, ticketId: 0 });
  if (!attachments) return badRequest("One of the files is not available. Upload it again.");

  const ticket = await createTicket(
    {
      subject,
      body: body ?? "",
      requester,
      author: { id: gate.id, name: gate.name || gate.username, email: gate.email },
      first_message_kind: kind,
      via: "desk",
      source: "desk",
      request_type_id: requestTypeId,
      answers,
      team_id: teamId,
      assignee_id: assigneeId,
      priority: priority as never,
      category: category ?? "",
      tags,
      attachments,
    },
    { actorId: gate.id, actorName: gate.name, origin: originOf(req) }
  );
  if (attachments.length) {
    const first = (await hq<{ id: number }>("SELECT id FROM hd_messages WHERE ticket_id = $1 ORDER BY id LIMIT 1", [ticket.id]))[0];
    if (first) await attachToMessage(attachments.map((x) => x.id), ticket.id, first.id, { userId: gate.id });
  }
  return NextResponse.json({ ticket }, { status: 201 });
}
