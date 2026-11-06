import "server-only";

// What a request form page needs before it renders (1.19.0), resolved on
// the server so the form and "What happens next" arrive together:
//
//   - the request type, only when this person may use it (active, and
//     theirs to use when restricted to groups);
//   - "What happens next": the type's published workflow told from the
//     requester's side, with the approver named ("Sara Haddad approves",
//     "Your manager, from the directory"), the teams of a parallel group
//     listed, a notify step left out (it is the desk's business);
//   - the answers prefilled from the person's own directory entry for
//     fields with `default_from: "directory:<key>"` (a built-in column such
//     as department or office, else a custom field), matched to an option
//     for a choice or select.

import { hq, hqOne } from "@/lib/helpdesk/db-core";
import { getRequestTypeBySlug, mayUseRequestType } from "@/lib/helpdesk/request-types";
import { getWorkflow } from "@/lib/helpdesk/workflows";
import { resolveManager, teamLeadIds } from "@/lib/helpdesk/approvals";
import type { HdFormAnswers, HdFormField, HdNextStep, HdRequestType, HdWorkflowStep } from "@/lib/helpdesk/types";

export interface RequestFormData {
  type: HdRequestType;
  nextSteps: HdNextStep[];
  defaults: HdFormAnswers;
}

const BUILTIN_DIRECTORY = new Set(["title", "department", "office", "email", "phone", "mobile", "name"]);

/** Null when there is no such type or the person may not use it: the page answers "isn't available". */
export async function loadRequestForm(user: { id: number }, slug: string): Promise<RequestFormData | null> {
  const type = await getRequestTypeBySlug(slug);
  if (!type || !(await mayUseRequestType(user, type.id))) return null;
  const [nextSteps, defaults] = await Promise.all([nextStepsFor(type, user.id), directoryDefaults(type.form, user.id)]);
  return { type, nextSteps, defaults };
}

async function teamNames(): Promise<Map<number, string>> {
  const rows = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams");
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function userName(id: number): Promise<string | null> {
  const r = await hqOne<{ name: string }>(
    "SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = $1 AND status = 'active'",
    [id]
  );
  return r?.name ?? null;
}

/** "IT, Facilities and HR". */
function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A short first line of a description, when it reads as a detail ("Usually 2 to 3 days"). */
function shortLine(text: string | undefined): string {
  const line = (text ?? "").split("\n")[0].trim();
  return line.length > 0 && line.length <= 80 ? line : "";
}

export async function nextStepsFor(type: HdRequestType, requesterId: number): Promise<HdNextStep[]> {
  const team = type.team_name || "The helpdesk";
  const workflow = type.workflow_id ? await getWorkflow(type.workflow_id) : undefined;
  const steps: HdWorkflowStep[] = workflow?.published ? (workflow.definition?.steps ?? []) : [];
  if (steps.length === 0) {
    return [
      { kind: "reply", title: `${team} replies`, detail: type.eta_label || "We'll email you when they do" },
      { kind: "finish", title: "Sorted, and solved", detail: "Reply any time to reopen it" },
    ];
  }
  const teams = await teamNames();
  const teamOf = (id: number) => teams.get(id) ?? "The team";
  const out: HdNextStep[] = [];
  for (const s of steps) {
    // The Request access workflow's approver ("space_owner", B's addition) is not in the shared union.
    const approver = s.kind === "approval" ? (s.approver as { kind: string; team_id?: number; user_id?: number }) : null;
    if (s.kind === "approval" && approver) {
      if (approver.kind === "manager") {
        const mgr = await resolveManager(requesterId);
        if (mgr) out.push({ kind: "approval", title: `${mgr.name} approves`, detail: "Your manager, from the directory" });
        else {
          const leads = type.team_id ? await teamLeadIds(type.team_id) : [];
          out.push({
            kind: "approval",
            title: `${team} approves`,
            detail: leads.length ? "Your manager isn't in the directory, so the team leads decide" : "Your manager isn't in the directory, so the team decides",
          });
        }
      } else if (approver.kind === "team" && approver.team_id) {
        out.push({ kind: "approval", title: `${teamOf(approver.team_id)} approves`, detail: shortLine(s.title) || "Any one of the team" });
      } else if (approver.kind === "user" && approver.user_id) {
        const name = await userName(approver.user_id);
        out.push({ kind: "approval", title: `${name ?? "The approver"} approves`, detail: shortLine(s.title) });
      } else {
        out.push({ kind: "approval", title: "The space's owner approves", detail: "Then you're added automatically" });
      }
    } else if (s.kind === "task") {
      out.push({ kind: "task", title: s.title, detail: shortLine(s.description) || teamOf(s.team_id) });
    } else if (s.kind === "parallel") {
      const names = [...new Set(s.steps.map((t) => teamOf(t.team_id)))];
      out.push({ kind: "task", title: s.title || "The teams get it ready", detail: listJoin(names) });
    } else if (s.kind === "wait") {
      out.push({ kind: "wait", title: s.title, detail: "Then the next step starts" });
    } else if (s.kind === "finish") {
      out.push({ kind: "finish", title: s.title, detail: "We'll tell you when it's done" });
    }
  }
  return out;
}

export async function directoryDefaults(form: HdFormField[], userId: number): Promise<HdFormAnswers> {
  const wanted = form.filter((f) => f.default_from?.startsWith("directory:"));
  if (wanted.length === 0) return {};
  const person = await hqOne<Record<string, unknown> & { custom: Record<string, unknown> | null }>(
    `SELECT p.name, p.title, p.department, p.office, p.email, p.phone, p.mobile, p.custom
       FROM users u JOIN directory_people p ON p.id = u.directory_person_id
      WHERE u.id = $1`,
    [userId]
  );
  if (!person) return {};
  const out: HdFormAnswers = {};
  for (const f of wanted) {
    const key = f.default_from!.slice("directory:".length);
    const raw = BUILTIN_DIRECTORY.has(key) ? person[key] : person.custom?.[key];
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!value) continue;
    if ((f.type === "choice" || f.type === "select") && f.options) {
      const v = value.toLowerCase();
      const opt = f.options.find((o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v);
      if (opt) out[f.key] = opt.value;
    } else if (f.type === "text" || f.type === "textarea") {
      out[f.key] = value;
    }
  }
  return out;
}
