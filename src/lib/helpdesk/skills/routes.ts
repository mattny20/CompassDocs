// Helpdesk 1.19.2: what the skills and languages API routes share (agent
// W2): the gates, the settings page's data, the rule editor's choices and
// preview, and the audit write. Server-only.
//
// Who may do what (J's desk roles; no new capability):
//   open Settings → Skills and languages   agents.manage_team or teams.manage
//   add, rename, remove skills/languages   teams.manage (the workspace's lists)
//   tag an agent                           teams.manage, or a lead for whom J's
//                                          Agents page lets them change
//                                          (rowManageable)
//   the rule editor's preview              automations.manage (as the rules)
//   set a ticket's language                anyone who can work the ticket

import "server-only";
import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "../../audit";
import type { SessionUser } from "../../types";
import { hq } from "../db-core";
import { listDeskAgents, rowManageable } from "../roles-agents";
import type { HdCapsView, HdDeskAgent } from "../roles-shared";
import { agentTagsFor, listSkills, listWorkspaceLanguages, SkillsError } from "./store";
import { agentMatches, languageName, languageOptions, matchTodayText, type HdAgentTags, type HdSkillCriteria, TICKET_LANGUAGE } from "./shared";

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export function skillsErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof SkillsError) return NextResponse.json({ error: e.message }, { status: e.status });
  return null;
}

export function idParam(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
}

/**
 * May this person tag this agent? teams.manage: anyone on the desk. A team
 * lead (agents.manage_team): only whom J's Agents page lets them change
 * (rowManageable: someone in one of their teams, below their own rank, never
 * themselves or a workspace Admin), since tags route that person's work in
 * every team they are in.
 */
export function canTagAgent(byId: number, view: HdCapsView, agent: HdDeskAgent): boolean {
  if (view.caps.includes("teams.manage")) return true;
  return rowManageable(byId, view, agent);
}

/** The rule editor's choices: every skill and the workspace's languages (the editor adds the detectable ones to the language condition). */
export async function skillChoices(): Promise<{ skills: { id: number; name: string }[]; languages: { code: string; name: string }[] }> {
  const [skills, langs] = await Promise.all([listSkills().catch(() => []), listWorkspaceLanguages().catch(() => [])]);
  return {
    skills: skills.map((s) => ({ id: s.id, name: s.name })),
    languages: langs.map((l) => ({ code: l.code, name: l.name })),
  };
}

/** A rule's skills action names skills that exist and a language the workspace has added. Returns an error sentence or null. */
export async function skillsRefsProblem(c: HdSkillCriteria): Promise<string | null> {
  if (c.skill_ids.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_skills WHERE id = ANY($1::int[])", [c.skill_ids]);
    if (found.length !== c.skill_ids.length) return "That skill does not exist.";
  }
  if (c.language && c.language !== TICKET_LANGUAGE) {
    const found = await hq("SELECT 1 FROM hd_languages WHERE code = $1", [c.language]);
    if (!found.length) return `Add ${languageName(c.language)} under Skills and languages first.`;
  }
  return null;
}

export interface SkillsAgentRow {
  user_id: number;
  name: string;
  email: string;
  team_ids: number[];
  teams: string[];
  skill_ids: number[];
  languages: string[];
  availability: "available" | "away" | "offline";
  /** The viewer may change this person's tags. */
  manageable: boolean;
}

export interface SkillsOverview {
  skills: Awaited<ReturnType<typeof listSkills>>;
  languages: Awaited<ReturnType<typeof listWorkspaceLanguages>>;
  agents: SkillsAgentRow[];
  /** The viewer may add, rename and remove skills and languages. */
  can_manage_lists: boolean;
  /** Every language a workspace can add. */
  catalogue: { value: string; label: string }[];
}

/** Settings → Skills and languages: the lists with counts and everyone on the desk with their tags. */
export async function skillsOverview(user: SessionUser): Promise<SkillsOverview> {
  const { hdCapsFor } = await import("../roles");
  const [skills, languages, agents, teams, view] = await Promise.all([
    listSkills(),
    listWorkspaceLanguages(),
    listDeskAgents(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name"),
    hdCapsFor(user),
  ]);
  const lists = view.caps.includes("teams.manage");
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const tags = await agentTagsFor(agents.map((a) => a.user_id));
  const rows: SkillsAgentRow[] = [];
  for (const a of agents) {
    const t = tags.get(a.user_id) ?? { skill_ids: [], languages: [] };
    rows.push({
      user_id: a.user_id,
      name: a.name,
      email: a.email,
      team_ids: a.team_ids,
      teams: a.team_ids.map((id) => teamName.get(id)).filter((n): n is string => Boolean(n)),
      skill_ids: t.skill_ids,
      languages: t.languages,
      availability: a.availability,
      manageable: canTagAgent(user.id, view, a),
    });
  }
  rows.sort((x, y) => x.name.localeCompare(y.name));
  return { skills, languages, agents: rows, can_manage_lists: lists, catalogue: languageOptions() };
}

export interface MatchPreview {
  /** The people who match and could take a ticket now. */
  agents: { user_id: number; name: string }[];
  /** "2 agents match today: Ana Kowalski, Marie Bernard." */
  text: string;
  /** Matching people who can't take one right now, and why ("Marie is away"). */
  unavailable: string[];
  /** With "the ticket's language": how many can take a ticket now, per workspace language. */
  by_language?: { code: string; name: string; count: number }[];
}

/**
 * The rule editor's "N agents match today": among the teams the rule can
 * reach (the team it moves tickets to, else the team it is limited to, else
 * every team), the people with the skills and language who could take a
 * ticket right now (the same checks as the team's turn: a desk role that
 * works the team's tickets and is included, not paused, available, on
 * shift, under the cap).
 */
export async function matchPreview(c: HdSkillCriteria, teamId: number | null, minRole: string | null): Promise<MatchPreview> {
  const { getTeamAssignment, loadOf } = await import("../assignment/store");
  const { teamCandidates } = await import("../assignment/engine");
  const { teamOpenState } = await import("../calendars");
  const teamIds = teamId ? [teamId] : (await hq<{ id: number }>("SELECT id FROM hd_teams ORDER BY position, name")).map((t) => t.id);
  const able = new Map<number, { name: string; tags?: HdAgentTags }>();
  const away = new Map<number, { name: string; why: string }>();
  const seen = new Map<number, string>();
  for (const id of teamIds) {
    const s = await getTeamAssignment(id);
    const open = await teamOpenState(id, new Date()).then((o) => o.open).catch(() => true);
    const cands = await teamCandidates(id, s, { minRole: (minRole as import("../roles-shared").HdRole | null) ?? null, open });
    const load = await loadOf(cands.map((x) => x.user_id));
    for (const x of cands) {
      seen.set(x.user_id, x.name);
      const open_count = load.get(x.user_id)?.open_count ?? 0;
      const cap = s.max_open_per_agent !== null && open_count >= s.max_open_per_agent ? `has ${open_count} open tickets` : "";
      const why = x.skip || cap;
      if (!why) able.set(x.user_id, { name: x.name });
      else if (!able.has(x.user_id)) away.set(x.user_id, { name: x.name, why });
    }
  }
  const ids = [...seen.keys()];
  const tags = await agentTagsFor(ids);
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  if (c.language === TICKET_LANGUAGE) {
    const langs = await listWorkspaceLanguages();
    const byLanguage = langs.map((l) => ({
      code: l.code,
      name: l.name,
      count: [...able.keys()].filter((id) => agentMatches(tags.get(id), c, l.code)).length,
    }));
    const any = [...able.entries()].filter(([id]) => byLanguage.some((l) => agentMatches(tags.get(id), c, l.code)));
    const parts = byLanguage.filter((l) => l.count > 0).map((l) => `${l.name} ${l.count}`);
    return {
      agents: any.map(([id, v]) => ({ user_id: id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)),
      text: parts.length ? `Agents who match today, by the ticket's language: ${parts.join(", ")}.` : "No agent matches today.",
      unavailable: [],
      by_language: byLanguage,
    };
  }
  const matching = [...able.entries()].filter(([id]) => agentMatches(tags.get(id), c, null)).map(([id, v]) => ({ user_id: id, name: v.name }));
  matching.sort((a, b) => a.name.localeCompare(b.name));
  const unavailable = [...away.entries()]
    .filter(([id]) => !able.has(id) && agentMatches(tags.get(id), c, null))
    .map(([, v]) => `${first(v.name)} ${v.why}`)
    .slice(0, 5);
  return { agents: matching, text: matchTodayText(matching.map((m) => m.name)), unavailable };
}

export type SkillsAuditAction =
  | "helpdesk.skills.skill_created"
  | "helpdesk.skills.skill_renamed"
  | "helpdesk.skills.skill_deleted"
  | "helpdesk.skills.language_added"
  | "helpdesk.skills.language_removed"
  | "helpdesk.skills.agent_updated"
  | "helpdesk.ticket.language_changed";

export async function auditSkills(
  req: Request,
  user: SessionUser,
  action: SkillsAuditAction,
  target: { type: "helpdesk_skill" | "helpdesk_language" | "user" | "helpdesk_ticket"; id?: number; label?: string },
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
