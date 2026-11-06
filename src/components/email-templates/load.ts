// Server-side loaders for the email template screens (1.19.0): the
// Templates tab, the composer and the four library tabs read the same
// facts, so the admin pages and the desk's entry point build their props
// here. Server-only.

import "server-only";
import { EMAIL_TEMPLATES, templateDef } from "@/lib/email-templates";
import {
  getComposition,
  listCompositions,
  listParts,
  listTeamVariants,
  partTags,
  isHelpdeskEvent,
  SCOPE_ALL,
} from "@/lib/email-parts";
import type { EmailComposition, EmailPartKind } from "@/lib/email-parts";
import { areaForKey } from "./areas";
import type { EventInfo, PartWithUsage, Surface, TagDef, TeamOption } from "./types";

export function eventInfos(surface: Surface): EventInfo[] {
  return EMAIL_TEMPLATES.filter((t) => surface.mode === "admin" || isHelpdeskEvent(t.key)).map((t) => ({
    key: t.key,
    label: t.label,
    description: t.description,
    area: areaForKey(t.key),
    tags: t.tags,
    teamScopes: isHelpdeskEvent(t.key),
  }));
}

export function eventInfo(key: string): EventInfo | null {
  const t = templateDef(key);
  if (!t) return null;
  return { key: t.key, label: t.label, description: t.description, area: areaForKey(t.key), tags: t.tags, teamScopes: isHelpdeskEvent(t.key) };
}

/** Helpdesk teams, for the scope switcher; none when the helpdesk tables are not there yet. */
export async function helpdeskTeams(): Promise<TeamOption[]> {
  try {
    const { listTeams } = await import("@/lib/helpdesk/teams");
    return (await listTeams()).map((t) => ({ id: t.id, name: t.name }));
  } catch {
    return [];
  }
}

export interface TemplatesListData {
  events: EventInfo[];
  compositions: EmailComposition[];
  /** Team variants per event key: the team ids that have one. */
  variants: Record<string, number[]>;
  parts: PartWithUsage[];
  teams: TeamOption[];
}

export async function loadTemplatesList(surface: Surface): Promise<TemplatesListData> {
  const events = eventInfos(surface);
  const [compositions, variantRows, parts, teams] = await Promise.all([
    listCompositions(SCOPE_ALL, events.map((e) => e.key)),
    listTeamVariants(),
    listParts(),
    helpdeskTeams(),
  ]);
  const variants: Record<string, number[]> = {};
  const teamIds = new Set(teams.map((t) => t.id));
  for (const v of variantRows) if (teamIds.has(v.team_id)) (variants[v.event_key] ??= []).push(v.team_id);
  return { events, compositions, variants, parts, teams };
}

export interface ComposerData {
  event: EventInfo;
  /** The composition per scope: 'all' plus every team (stored or inheriting). */
  compositions: Record<string, EmailComposition>;
  parts: PartWithUsage[];
  teams: TeamOption[];
}

export async function loadComposer(key: string): Promise<ComposerData | null> {
  const event = eventInfo(key);
  if (!event) return null;
  const teams = event.teamScopes ? await helpdeskTeams() : [];
  const scopes = [SCOPE_ALL, ...teams.map((t) => `hd_team:${t.id}`)];
  const [comps, frames] = await Promise.all([Promise.all(scopes.map((s) => getComposition(key, s))), listParts()]);
  const compositions: Record<string, EmailComposition> = {};
  comps.forEach((c, i) => {
    if (c) compositions[scopes[i]] = c;
  });
  // Bodies are the event's own; the other kinds are shared libraries.
  const parts = frames.filter((p) => p.kind !== "body" || p.event_key === key);
  return { event, compositions, parts, teams };
}

export interface LibraryData {
  kind: EmailPartKind;
  parts: PartWithUsage[];
  events: EventInfo[];
  /** The tags a part of this kind may use; bodies add their event's (tagsByEvent). */
  tags: TagDef[];
  tagsByEvent: Record<string, TagDef[]>;
}

export async function loadLibrary(surface: Surface, kind: EmailPartKind): Promise<LibraryData> {
  const events = eventInfos(surface);
  const all = await listParts({ kind });
  const keys = new Set(events.map((e) => e.key));
  const parts = kind === "body" ? all.filter((p) => p.event_key && keys.has(p.event_key)) : all;
  const tagsByEvent: Record<string, TagDef[]> = {};
  if (kind === "body") for (const e of events) tagsByEvent[e.key] = partTags("body", e.key);
  return { kind, parts, events, tags: partTags(kind), tagsByEvent };
}
