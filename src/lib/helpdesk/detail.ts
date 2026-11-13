// Helpdesk 1.19.0: the two detail reads. HdTicketDetail is the agent's
// (everything: internal notes, SLA, requester card, workflow with task
// numbers, suggestions); HdRequestDetail is the requester's and the
// approver's (requester-safe: public and system messages only, no internal
// fields). Access is decided by the caller with lib/helpdesk/access; these
// only assemble. Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import { requesterSafe } from "./access";
import { getHelpdeskSettings } from "./settings";
import { listMessages } from "./messages";
import { clockNote, hoursForTicket, slaPolicyForTicket, slaTargetNote } from "./calendars";
import { clockState, formatDuration, HD_NO_OPEN_HOURS_DUE, resolveElapsedPercent } from "./sla";
import { listChildTickets, requesterHistory } from "./tickets";
import { suggestArticles } from "./suggest";
import { HD_ACTIVE_RUN_STATES, HD_OPEN_STATUSES, HD_PAUSED_STATUSES } from "./types";
import type {
  HdFormField,
  HdRequestDetail,
  HdRequesterCard,
  HdTicket,
  HdTicketDetail,
  HdWorkflowProgress,
} from "./types";
import type { Role } from "../types";

async function requestForm(requestTypeId: number | null): Promise<HdFormField[]> {
  if (!requestTypeId) return [];
  const row = await hqOne<{ form: HdFormField[] }>("SELECT form FROM hd_request_types WHERE id = $1", [requestTypeId]);
  return Array.isArray(row?.form) ? row!.form : [];
}

async function progress(ticketId: number, audience: "requester" | "agent"): Promise<HdWorkflowProgress | null> {
  try {
    const { getWorkflowProgress } = await import("./engine");
    return await getWorkflowProgress(ticketId, audience);
  } catch {
    return null;
  }
}

/**
 * The requester card: account, directory entry (title, department, Reports
 * to, office), history. The directory's visibility rules hold here as on
 * the contact card (lib/directory-viewer): a field set to admins-only is
 * blank for a non-admin `viewer`, and a hidden person is never named as
 * the manager. No viewer: treated as a non-admin.
 */
export async function requesterCard(t: HdTicket, viewer?: { role: Role }): Promise<HdRequesterCard> {
  const [person, scope] = await Promise.all([
    hqOne<{ title: string; department: string; office: string; manager: string | null }>(
    `SELECT p.title, p.department, p.office,
            (SELECT mp.name FROM directory_person_links l JOIN directory_people mp ON mp.id = l.target_id AND mp.hidden = 0
              WHERE l.person_id = p.id AND l.field_key = 'manager' ORDER BY l.sort LIMIT 1) AS manager
       FROM directory_people p
      WHERE p.hidden = 0 AND (
            p.id = (SELECT directory_person_id FROM users WHERE id = $1)
         OR ($1::int IS NULL AND $2 <> '' AND lower(p.email) = lower($2)))
      LIMIT 1`,
    [t.requester_id, t.requester_email]
    ),
    (async () => {
      const [{ listFields }, { viewerScope }] = await Promise.all([import("../directory"), import("../directory-viewer")]);
      return viewerScope({ role: viewer?.role ?? "viewer" }, await listFields());
    })(),
  ]);
  const shown = (key: string, v: string | null | undefined) => (v && !scope.hidden.has(key) ? v : "");
  const hist = await requesterHistory(t.requester_id, t.requester_email, t.id);
  return {
    user_id: t.requester_id,
    name: t.requester_name,
    email: t.requester_email,
    title: shown("title", person?.title),
    department: shown("department", person?.department),
    manager: shown("manager", person?.manager),
    office: shown("office", person?.office),
    presence: null,
    earlier_count: hist.count,
    last_ticket_at: hist.last_at,
  };
}

/** The agent's full view of a ticket. */
export async function ticketDetail(user: { id: number; role: Role }, t: HdTicket, canWork: boolean): Promise<HdTicketDetail> {
  const [messages, requester, form, workflow, children, hours, policy, parent] = await Promise.all([
    listMessages(t.id),
    requesterCard(t, user),
    requestForm(t.request_type_id),
    t.workflow_run_id ? progress(t.id, "agent") : Promise.resolve(null),
    listChildTickets(t.id),
    hoursForTicket(t),
    t.first_reply_due || t.resolve_due ? slaPolicyForTicket(t) : Promise.resolve(undefined),
    t.parent_ticket_id
      ? hqOne<{ number: number; subject: string; deleted?: boolean }>(
          // 1.19.4 (C7): a request in the recycle bin shows as "a deleted ticket", never by number or subject.
          "SELECT CASE WHEN deleted_at IS NULL THEN number ELSE 0 END AS number, CASE WHEN deleted_at IS NULL THEN subject ELSE '' END AS subject, (deleted_at IS NOT NULL) AS deleted FROM hd_tickets WHERE id = $1",
          [t.parent_ticket_id]
        )
      : Promise.resolve(undefined),
  ]);
  try {
    const { contactCardFor } = await import("./contact-cards");
    requester.card = await contactCardFor(user, t.requester_id, {
      ticket: t,
      audience: "agent",
      fallback: { name: t.requester_name, email: t.requester_email },
    });
  } catch (e) {
    console.error("[helpdesk] contact card:", e);
  }
  const now = Date.now();
  const paused = !!t.sla_paused_at && HD_PAUSED_STATUSES.includes(t.status);
  const closed = !HD_OPEN_STATUSES.includes(t.status);
  const fr = clockState(t.first_reply_due, t.first_replied_at, t.created_at, paused, now);
  const rs = clockState(t.resolve_due, closed ? t.solved_at : null, t.created_at, paused, now);
  const label = (c: typeof fr): string => {
    if (!c.due) return "";
    const d = Date.parse(c.due);
    if (c.state === "met" && c.met_at) return `Met in ${formatDuration(Date.parse(c.met_at) - Date.parse(t.created_at))}`;
    if (c.state === "breached" && c.met_at) return `Missed by ${formatDuration(Date.parse(c.met_at) - d)}`;
    if (c.state === "breached") return `Overdue ${formatDuration(now - d)}`;
    if (c.state === "paused") return "Paused";
    if (d >= HD_NO_OPEN_HOURS_DUE) return "No office hours";
    return `Due in ${formatDuration(d - now)}`;
  };
  // Agent L's notes: why a running clock is stopped, and where the target comes from.
  const [clock_note, sla_target_note] = await Promise.all([
    clockNote(t, now).catch(() => null),
    policy ? slaTargetNote(t).catch(() => "") : Promise.resolve(""),
  ]);
  return {
    ticket: t,
    messages,
    requester,
    form,
    sla: {
      policy: policy ?? null,
      first_reply: { due: fr.due, met_at: fr.met_at, state: fr.state, label: label(fr) },
      resolve: { due: rs.due, met_at: rs.met_at, state: rs.state, label: label(rs) },
      resolve_elapsed_percent: resolveElapsedPercent(t, policy ?? null, hours, now),
    },
    workflow,
    children,
    parent: parent ?? null,
    suggested_articles: canWork ? await suggestArticles(user, t.subject, 3).catch(() => []) : [],
    can_work: canWork,
    clock_note,
    sla_target_note,
    // Merged into / merged in, and "from #1051" on moved messages (1.19.1, lib/helpdesk/merge).
    merge: await import("./merge").then((m) => m.mergeInfo(t.id)).catch(() => undefined),
    // The address it is answered from, and the choices while more than one is listed (1.20.2, lib/helpdesk/mailboxes).
    ...(await mailboxFields(user, t, canWork)),
    // "Before you solve" (1.20.5, lib/helpdesk/solve-requirements): the answers kept on the ticket, and whether a set applies.
    ...(await solveFields(t)),
    // Custom fields (1.20.6, lib/helpdesk/custom-fields): the fields of the ticket's team with their values. None defined: one cached lookup.
    ...(await customFields(t)),
  };
}

/** 1.20.6 (lib/helpdesk/desk-calendar): the ticket's event, and whether its setup still holds a solve. */
async function eventFields(t: HdTicket): Promise<{ event?: HdTicketDetail["event"]; setupOpen: boolean }> {
  try {
    const event = await (await import("./desk-calendar")).getTicketEvent(t.id);
    return event ? { event, setupOpen: !event.cancelled && !event.setup_complete } : { setupOpen: false };
  } catch (e) {
    console.error("[helpdesk] ticket event:", e);
    return { setupOpen: false };
  }
}

async function customFields(t: HdTicket): Promise<Pick<HdTicketDetail, "custom_fields">> {
  try {
    const custom_fields = await (await import("./custom-fields")).ticketCustomFields(t);
    return custom_fields.length ? { custom_fields } : {};
  } catch (e) {
    console.error("[helpdesk] custom fields:", e);
    return {};
  }
}

/** The requester's side (1.20.6): only the Public custom fields that have a value. */
async function publicDetails(t: HdTicket): Promise<Pick<HdRequestDetail, "details">> {
  try {
    const details = await (await import("./custom-fields")).publicCustomDetails(t);
    return details.length ? { details } : {};
  } catch (e) {
    console.error("[helpdesk] custom fields:", e);
    return {};
  }
}

async function solveFields(t: HdTicket): Promise<Pick<HdTicketDetail, "solve_details" | "before_solve" | "event">> {
  try {
    const { solveSetsApplyTo, ticketSolveDetails } = await import("./solve-requirements");
    const [solve_details, applies, ev] = await Promise.all([ticketSolveDetails(t.id), solveSetsApplyTo(t), eventFields(t)]);
    // 1.20.6: an event whose setup is open is asked about before a solve too, set or no set.
    const before_solve = applies || ev.setupOpen;
    return { ...(solve_details.length ? { solve_details } : {}), ...(before_solve ? { before_solve } : {}), ...(ev.event ? { event: ev.event } : {}) };
  } catch (e) {
    console.error("[helpdesk] solve details:", e);
    return {};
  }
}

async function mailboxFields(user: { id: number; role: Role }, t: HdTicket, canWork: boolean): Promise<Pick<HdTicketDetail, "mailbox" | "mailboxes" | "can_change_mailbox">> {
  try {
    const { mailboxOptionsFor, ticketMailbox } = await import("./mailboxes");
    const [mailbox, { options, total }] = await Promise.all([ticketMailbox(t), mailboxOptionsFor(user)]);
    if (total < 2) return { mailbox };
    // The choices are the agent's own (the default, addresses with no team, their teams'). The
    // address in use is always named, as a plain label when there is nothing else to choose.
    const choice = options.some((o) => o.id !== mailbox?.id);
    const { hdCan } = await import("./roles");
    return { mailbox, mailboxes: options, can_change_mailbox: canWork && choice && (await hdCan(user, "tickets.reply_public", { teamId: t.team_id })) };
  } catch (e) {
    console.error("[helpdesk] ticket mailbox:", e);
    return { mailbox: null };
  }
}

/**
 * The requester's (or an approver's) view: public and system messages, the
 * form and its answers, the workflow as the requester lives it.
 */
export async function requestDetail(
  user: { id: number },
  t: HdTicket,
  relation: "requester" | "approver" | "agent" | "cc"
): Promise<HdRequestDetail> {
  const [messages, form, workflow, settings] = await Promise.all([
    listMessages(t.id, { includeInternal: false }),
    requestForm(t.request_type_id),
    t.workflow_run_id ? progress(t.id, "requester") : Promise.resolve(null),
    getHelpdeskSettings(),
  ]);
  const safe = requesterSafe(t, messages);
  const { answerRows } = await import("./request-types");
  const answers = form.length ? await answerRows(form, t.form_answers ?? {}) : [];
  const isRequester = t.requester_id === user.id;
  let myApproval: HdRequestDetail["my_approval"] = null;
  if (relation === "approver" || !isRequester) {
    try {
      const { listMyApprovals } = await import("./approvals");
      const mine = (await listMyApprovals(user, "pending", 200)).find((a) => a.ticket_number === t.number && a.can_decide);
      if (mine) myApproval = { id: mine.id, title: mine.step_title };
    } catch {
      myApproval = null;
    }
  }
  return {
    ...safe.summary,
    current_step: currentStep(workflow),
    requester_name: t.requester_name,
    form,
    form_answers: t.form_answers ?? {},
    messages: safe.messages,
    answers,
    workflow,
    csat_comment: isRequester ? t.csat_comment : "",
    // A CC (1.19.1, lib/helpdesk/ccs) replies in public as the requester does.
    can_reply: (isRequester || (await isCcOfRequest(user.id, t.id, relation))) && t.status !== "closed",
    can_rate: isRequester && settings.csat_enabled && (t.status === "solved" || t.status === "closed") && t.csat_score === null,
    my_approval: myApproval,
    // 1.20.6: the Public custom fields with a value (lib/helpdesk/custom-fields); agent-only fields are never read here.
    ...(await publicDetails(t)),
  };
}

/** The caller is copied on the request (agent V3's CCs) and does not work it (they reply from the desk). */
async function isCcOfRequest(userId: number, ticketId: number, relation: string): Promise<boolean> {
  if (relation === "cc") return true;
  if (relation === "agent") return false;
  const { isCcOf } = await import("./ccs");
  return isCcOf(userId, ticketId);
}

/** The ticket ids a requester's request maps to by number (helper for routes). */
export async function ticketIdByNumber(number: number): Promise<number | undefined> {
  return (await hq<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1", [number]))[0]?.id;
}

// --- Request forms -------------------------------------------------------------

const DIRECTORY_BUILTIN = new Set(["title", "department", "office", "phone", "mobile", "email", "name"]);

/**
 * Answers prefilled from the requester's directory entry: a field with
 * default_from "directory:<key>" takes the entry's built-in (title,
 * department, office, phone…) or custom value; "directory:manager" on a
 * user field takes the manager's account id. Missing values are left out.
 */
export async function directoryDefaults(userId: number, form: HdFormField[]): Promise<import("./types").HdFormAnswers> {
  const wanted = form.filter((f) => typeof f.default_from === "string" && f.default_from.startsWith("directory:"));
  if (!wanted.length) return {};
  const p = await hqOne<Record<string, unknown> & { id: number; custom: Record<string, unknown> }>(
    `SELECT p.* FROM directory_people p WHERE p.hidden = 0 AND p.id = (SELECT directory_person_id FROM users WHERE id = $1)`,
    [userId]
  );
  if (!p) return {};
  const out: import("./types").HdFormAnswers = {};
  for (const f of wanted) {
    const key = f.default_from!.slice("directory:".length);
    if (key === "manager") {
      const m = await hqOne<{ id: number; name: string }>(
        `SELECT u.id, mp.name FROM directory_person_links l JOIN directory_people mp ON mp.id = l.target_id
           LEFT JOIN users u ON u.directory_person_id = mp.id AND u.status = 'active'
          WHERE l.person_id = $1 AND l.field_key = 'manager' ORDER BY l.sort LIMIT 1`,
        [p.id]
      );
      if (m) out[f.key] = f.type === "user" ? (m.id ?? null) : m.name;
      continue;
    }
    const v = DIRECTORY_BUILTIN.has(key) ? p[key] : (p.custom ?? {})[key];
    if (typeof v === "string" && v.trim()) out[f.key] = v.trim().slice(0, 500);
    else if (typeof v === "number") out[f.key] = v;
  }
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

/** "What happens next" for a request type, from its published workflow (or the team's reply). */
export async function nextStepsFor(rt: import("./types").HdRequestType): Promise<import("./types").HdNextStep[]> {
  const teamNames = new Map((await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams")).map((t) => [t.id, t.name]));
  const team = (id: number | null | undefined) => (id ? teamNames.get(id) ?? "The team" : "The team");
  const wf = rt.workflow_id
    ? await hqOne<{ definition: import("./types").HdWorkflowDefinition; published: number }>(
        "SELECT definition, published FROM hd_workflows WHERE id = $1",
        [rt.workflow_id]
      )
    : undefined;
  if (!wf || !wf.published || !Array.isArray(wf.definition?.steps) || !wf.definition.steps.length) {
    return [{ kind: "reply", title: `${team(rt.team_id)} replies`, detail: rt.eta_label || "We'll reply here and by email." }];
  }
  const out: import("./types").HdNextStep[] = [];
  for (const s of wf.definition.steps) {
    switch (s.kind) {
      case "approval": {
        const a = s.approver;
        let detail = "";
        if (a.kind === "manager") detail = "Your manager, from the directory";
        else if (a.kind === "team") detail = `Someone in ${team(a.team_id)}`;
        else if (a.kind === "space_owner") detail = "The space's owner";
        else if (a.kind === "user") {
          detail = (await hqOne<{ name: string }>("SELECT name FROM users WHERE id = $1", [a.user_id]))?.name ?? "";
        }
        out.push({ kind: "approval", title: s.title, detail });
        break;
      }
      case "task":
        out.push({ kind: "task", title: s.title, detail: team(s.team_id) });
        break;
      case "parallel":
        out.push({
          kind: "task",
          title: s.title || "Getting it ready",
          detail: [...new Set(s.steps.map((t) => team(t.team_id)))].join(", "),
        });
        break;
      case "wait":
        out.push({ kind: "wait", title: s.title, detail: "" });
        break;
      case "notify":
        break;
      case "finish":
        out.push({ kind: "finish", title: s.title, detail: rt.eta_label || "We'll tell you when it's done." });
        break;
    }
  }
  return out;
}

/** "step 3 of 4: IT is setting it up": the first active step (else the first pending one) of a running workflow. */
export function currentStep(w: HdWorkflowProgress | null): HdRequestDetail["current_step"] {
  if (!w || !HD_ACTIVE_RUN_STATES.includes(w.state) || !w.steps.length) return null;
  let i = w.steps.findIndex((x) => x.state === "active");
  if (i < 0) i = w.steps.findIndex((x) => x.state === "pending");
  if (i < 0) return null;
  const step = w.steps[i];
  const team = step.team_name ?? (step.kind === "task" ? step.detail.split(" · ")[0] || null : null);
  return { index: i + 1, total: w.steps.length, title: step.title, team_name: team };
}
