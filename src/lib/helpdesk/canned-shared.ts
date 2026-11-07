// Helpdesk 1.19.2: canned responses (agent W4), the pure half shared by the
// desk (client) and lib/helpdesk/canned (server). No server imports here.
//
// A canned response is TEXT ONLY: an agent inserts it at the cursor in a
// reply or an internal note, by typing ";" (then a few letters) or with the
// composer's Canned response button. It never changes the ticket; macros
// (lib/helpdesk/macros) do that.
//
// Placeholders are filled when the text is inserted, for that ticket and
// that agent. A placeholder this module does not know becomes nothing, so a
// sent reply never carries raw {{braces}}; saving one is refused, so the
// library never holds one in the first place.

import { mdInline } from "./md-inline";

export const CANNED_LIMITS = { title: 120, body: 10_000, folder: 60, total: 2000, personal: 200, query: 40 } as const;

/** The ";" picker shows (and Enter or Tab inserts) only from this many letters after the ";". */
export const CANNED_INLINE_MIN_QUERY = 2;

/**
 * Is the ";" picker on screen (so Enter and Tab insert)? Only with at least
 * CANNED_INLINE_MIN_QUERY letters after the ";" and at least one response
 * whose name or folder matches them. Otherwise the keys are the box's own:
 * " ;" then Enter is a line break, ";D" stays a wink.
 */
export function inlinePickerShows(query: string, labelMatches: number): boolean {
  return query.trim().length >= CANNED_INLINE_MIN_QUERY && labelMatches > 0;
}

export type HdCannedScope = "personal" | "team" | "workspace";

/** A canned response as the desk reads it. */
export interface HdCanned {
  id: number;
  title: string;
  body: string;
  folder: string;
  scope: HdCannedScope;
  owner_id: number | null;
  team_id: number | null;
  team_name: string | null;
  /** Inserts in the last 30 days (every agent's). */
  uses_30d: number;
  updated_at: string;
  /** Library only: may the caller edit or delete it? */
  can_edit?: boolean;
}

export interface CannedPlaceholder {
  tag: string;
  /** The words on the editor's chip ("requester first name"). */
  label: string;
}

/** The placeholders a canned response may use, in the order the editor offers them. */
export const CANNED_PLACEHOLDERS: readonly CannedPlaceholder[] = [
  { tag: "requester.first_name", label: "requester first name" },
  { tag: "requester.name", label: "requester name" },
  { tag: "ticket.number", label: "ticket number" },
  { tag: "team.name", label: "team" },
  { tag: "agent.first_name", label: "my first name" },
  { tag: "agent.name", label: "my name" },
];

const KNOWN = new Set(CANNED_PLACEHOLDERS.map((p) => p.tag));

/** {{ tag }}, tolerant of spaces and case; anything between the braces that is not a brace. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function placeholderLabel(tag: string): string {
  return CANNED_PLACEHOLDERS.find((p) => p.tag === tag.toLowerCase())?.label ?? tag;
}

/**
 * Braces left over once the placeholders are taken out: a typo such as
 * "{{requester.first_name}" or "{{ticket.number". Saving refuses them.
 */
export function strayBraces(body: string): boolean {
  return /\{\{|\}\}/.test(body.replace(PLACEHOLDER, ""));
}

/** Placeholders in `body` this module does not fill, as written ("{{ticket.url}}"). */
export function unknownPlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(m[1].toLowerCase()) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** The body as text and placeholder pieces (the editor draws the placeholders as chips). */
export function splitPlaceholders(body: string): ({ text: string } | { tag: string })[] {
  const out: ({ text: string } | { tag: string })[] = [];
  let at = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    const tag = m[1].toLowerCase();
    if (!KNOWN.has(tag)) continue;
    if (m.index! > at) out.push({ text: body.slice(at, m.index) });
    out.push({ tag });
    at = m.index! + m[0].length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * One value escaped for the Markdown a reply is ("*Bob*" stays those characters), on one
 * line: lib/helpdesk/md-inline, so it can't become a link (www. and addresses too), a
 * directive, or a heading or list at the start of a line (1.19.4 review).
 */
export function escapeMarkdownInline(s: string): string {
  return mdInline(s);
}

export interface CannedValues {
  requesterName: string;
  ticketNumber: number | null;
  teamName: string;
  agentName: string;
}

/**
 * Fill a canned response for one ticket and one agent. Pure. A requester
 * without a name reads "there" (as macros do); a value that is missing
 * otherwise, and any placeholder this module does not know, is left out,
 * and so is a malformed one ("{{requester.first_name}", "{{ticket.number")
 * or a stray "}}" (a typo saved before the save-time check).
 * Never returns {{ or }}.
 */
export function renderCanned(body: string, v: CannedValues): string {
  const requesterFirst = firstNameOf(v.requesterName);
  const values: Record<string, string> = {
    "requester.first_name": escapeMarkdownInline(requesterFirst || "there"),
    "requester.name": escapeMarkdownInline(v.requesterName.trim() || "there"),
    "ticket.number": v.ticketNumber ? String(v.ticketNumber) : "",
    "team.name": escapeMarkdownInline(v.teamName.trim()),
    "agent.first_name": escapeMarkdownInline(firstNameOf(v.agentName)),
    "agent.name": escapeMarkdownInline(v.agentName.trim()),
  };
  return body.replace(PLACEHOLDER, (_whole, tag: string) => values[tag.toLowerCase()] ?? "").replace(/\{\{[^{}\s]*\}?/g, "").replace(/\}\}/g, "");
}

// --- The ";" trigger -------------------------------------------------------------

/**
 * Is the caret just after a ";" trigger? Returns where the ";" is and what
 * was typed after it, or null. The ";" must start a word (the start of the
 * text, or after a space or a line break), so "a;b", "foo;" and a URL's
 * ";jsessionid=…" never fire, and the query must start with a letter or a
 * digit, so "; " (punctuation) and ";)" never fire either. The query stays
 * on the caret's line, holds no double space and no further ";", and is at
 * most CANNED_LIMITS.query characters.
 */
export function cannedTrigger(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const start = text.lastIndexOf(";", caret - 1);
  if (start < lineStart) return null;
  const before = start === 0 ? "" : text[start - 1];
  if (before && !/\s/.test(before)) return null;
  const query = text.slice(start + 1, caret);
  if (query.length > CANNED_LIMITS.query) return null;
  if (query && !/^[\p{L}\p{N}]/u.test(query)) return null;
  if (/\s\s/.test(query)) return null;
  return { start, query };
}

// --- Picker ----------------------------------------------------------------------

/**
 * Does the response match what was typed? Every word in the title, folder
 * or (with `fields` "all", the button's search and the library) the text.
 * The ";" picker matches names and folders only ("label"), so ";D" or a
 * word typed after ";" never finds a response through its text.
 */
export function cannedMatches(c: Pick<HdCanned, "title" | "body" | "folder">, query: string, fields: "all" | "label" = "all"): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = (fields === "all" ? `${c.title}\n${c.folder}\n${c.body}` : `${c.title}\n${c.folder}`).toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface CannedGroup {
  key: string;
  label: string;
  items: HdCanned[];
}

/**
 * The picker's groups: the ticket's team first, then the agent's other
 * teams (by name), then the workspace's, then their own ("Mine"). Within a
 * group, a title match comes before a text match, then the most used.
 */
export function groupCanned(list: HdCanned[], query: string, ticketTeamId: number | null, fields: "all" | "label" = "all"): CannedGroup[] {
  const q = query.trim().toLowerCase();
  const hits = list.filter((c) => cannedMatches(c, q, fields));
  const rank = (c: HdCanned) => (q && c.title.toLowerCase().includes(q) ? 0 : 1);
  const sort = (a: HdCanned, b: HdCanned) => rank(a) - rank(b) || b.uses_30d - a.uses_30d || a.title.localeCompare(b.title);
  const teams = new Map<number, CannedGroup>();
  const workspace: HdCanned[] = [];
  const mine: HdCanned[] = [];
  for (const c of hits) {
    if (c.scope === "personal") mine.push(c);
    else if (c.scope === "workspace" || c.team_id === null) workspace.push(c);
    else {
      const g = teams.get(c.team_id) ?? { key: `team:${c.team_id}`, label: c.team_name || "Team", items: [] };
      g.items.push(c);
      teams.set(c.team_id, g);
    }
  }
  const teamGroups = [...teams.entries()]
    .sort(([a, ga], [b, gb]) => (a === ticketTeamId ? -1 : b === ticketTeamId ? 1 : ga.label.localeCompare(gb.label)))
    .map(([, g]) => ({ ...g, items: g.items.sort(sort) }));
  const out: CannedGroup[] = [...teamGroups];
  if (workspace.length) out.push({ key: "workspace", label: "Workspace", items: workspace.sort(sort) });
  if (mine.length) out.push({ key: "mine", label: "Mine", items: mine.sort(sort) });
  return out;
}

/** "Only me", the team's name or "Workspace": the library's Shared with chip. */
export function sharedWithLabel(c: Pick<HdCanned, "scope" | "team_name">): string {
  if (c.scope === "personal") return "Only me";
  if (c.scope === "team") return c.team_name || "One team";
  return "Workspace";
}

/** The editor's Shared with choice as sent to the API. */
export type CannedShare = "me" | "workspace" | `team:${number}`;

export function shareOf(c: { owner_id: number | null; team_id: number | null }): CannedShare {
  if (c.owner_id) return "me";
  return c.team_id ? `team:${c.team_id}` : "workspace";
}

/** Parse a Shared with value; null when it is not one. */
export function parseShare(v: unknown): { scope: HdCannedScope; teamId: number | null } | null {
  if (v === "me") return { scope: "personal", teamId: null };
  if (v === "workspace") return { scope: "workspace", teamId: null };
  if (typeof v === "string") {
    const m = /^team:(\d{1,9})$/.exec(v);
    if (m && Number(m[1]) > 0) return { scope: "team", teamId: Number(m[1]) };
  }
  return null;
}
