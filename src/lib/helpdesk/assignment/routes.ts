// Helpdesk 1.19.0: what the assignment API routes share (agent N): the team
// gate (agents.manage_team in that team, via J's hdCapGate), the choices the
// rule editor offers, and the audit write. Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "../../audit";
import type { SessionUser } from "../../types";
import { hq, hqOne } from "../db-core";
import { hdCan, hdCapGate } from "../roles";
import { assignmentReady } from "./store";

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function idParam(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

/** agents.manage_team for this team (its leads; anyone with teams.manage for every team). 404 for a team that doesn't exist. */
export async function teamGate(rawTeamId: string | undefined): Promise<{ user: SessionUser; team: { id: number; name: string } } | NextResponse> {
  const teamId = idParam(rawTeamId);
  if (!teamId) return notFound();
  const gate = await hdCapGate("agents.manage_team", { teamId });
  if (gate instanceof NextResponse) return gate;
  await assignmentReady();
  const team = await hqOne<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = $1", [teamId]);
  if (!team) return notFound();
  return { user: gate, team };
}

/** The teams this person may configure assignment for. */
export async function manageableTeams(user: SessionUser): Promise<{ id: number; name: string; icon: string; mode: string }[]> {
  await assignmentReady();
  const teams = await hq<{ id: number; name: string; icon: string; mode: string }>(
    `SELECT t.id, t.name, t.icon, COALESCE(a.mode, 'manual') AS mode
       FROM hd_teams t LEFT JOIN hd_team_assignment a ON a.team_id = t.id ORDER BY t.position, t.name`
  );
  const out = [];
  for (const t of teams) if (await hdCan(user, "agents.manage_team", { teamId: t.id })) out.push(t);
  return out;
}

export interface RuleChoices {
  teams: { id: number; name: string }[];
  request_types: { id: number; name: string }[];
  integrations: { id: number; name: string }[];
  agents: { id: number; name: string }[];
  form_fields: { key: string; label: string }[];
}

/** What the rule editor's pickers list. */
export async function ruleChoices(): Promise<RuleChoices> {
  const [teams, types, agents] = await Promise.all([
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name"),
    hq<{ id: number; name: string; form: { key?: string; label?: string }[] }>("SELECT id, title AS name, form FROM hd_request_types ORDER BY position, title"),
    hq<{ id: number; name: string }>(
      `SELECT DISTINCT u.id, u.name FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' ORDER BY u.name`
    ),
  ]);
  const integrations = await hq<{ id: number; name: string }>("SELECT id, name FROM hd_integrations ORDER BY name").catch(() => []);
  const seen = new Map<string, string>();
  for (const t of types) for (const f of Array.isArray(t.form) ? t.form : []) if (f?.key && !seen.has(f.key)) seen.set(f.key, f.label || f.key);
  return {
    teams,
    request_types: types.map((t) => ({ id: t.id, name: t.name })),
    integrations,
    agents,
    form_fields: [...seen].map(([key, label]) => ({ key, label })).slice(0, 200),
  };
}

export type AssignmentAuditAction =
  | "helpdesk.assignment.team_updated"
  | "helpdesk.assignment.rule_created"
  | "helpdesk.assignment.rule_updated"
  | "helpdesk.assignment.rule_deleted"
  | "helpdesk.assignment.rules_reordered"
  | "helpdesk.assignment.on_call_updated"
  | "helpdesk.assignment.member_paused";

export async function auditAssignment(
  req: Request,
  user: SessionUser,
  action: AssignmentAuditAction,
  target: { type: "helpdesk_team" | "helpdesk_assignment_rule" | "user"; id?: number; label?: string },
  details: Record<string, unknown>
): Promise<void> {
  await audit({
    actor: actorFrom(user),
    action,
    targetType: target.type,
    targetId: target.id,
    targetLabel: target.label,
    details,
    ip: ipFrom(req),
  });
}

/** The teams and person a rule names exist (and the person is active). Returns an error sentence or null. */
export async function ruleRefsProblem(input: { scope_team_id?: number | null; action?: { team_id?: number | null; user_id?: number | null } }): Promise<string | null> {
  const teamIds = [input.scope_team_id, input.action?.team_id].filter((x): x is number => typeof x === "number");
  if (teamIds.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [teamIds]);
    if (found.length !== new Set(teamIds).size) return "That team does not exist.";
  }
  if (input.action?.user_id) {
    const u = await hqOne("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [input.action.user_id]);
    if (!u) return "That person is not an active user.";
  }
  return null;
}
