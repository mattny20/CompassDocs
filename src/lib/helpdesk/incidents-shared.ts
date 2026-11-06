// Helpdesk 1.19.2: major incidents (agent W1), the part the desk, Get help
// and the server share: limits, the shapes the routes answer, input checks
// and the auto-link rule's matcher. No server imports here.

export const INCIDENT_LIMITS = {
  title: 200,
  /** The auto-link rule: up to five comma-separated terms. */
  match: 120,
  terms: 5,
  term: 60,
  update: 5000,
  /** Tickets linked in one request (declare, Link tickets). */
  link: 200,
} as const;

export const INCIDENT_BANNERS = ["workspace", "team", "off"] as const;
export type IncidentBanner = (typeof INCIDENT_BANNERS)[number];

export const INCIDENT_BANNER_LABEL: Record<IncidentBanner, string> = {
  workspace: "Everyone",
  team: "The team's requesters",
  off: "Off",
};

export type IncidentLinkVia = "declare" | "manual" | "rule";

/** What a linked ticket's requester reads when their ticket is linked (a public message, and the notice). */
export function linkedNote(title: string): string {
  return `We know about this problem: "${title}". We're working on it and will keep you posted here, so there's no need to send anything else.`;
}

/** The ticket opened for the incident starts with this internal note. */
export function declaredNote(by: string, numbers: number[]): string {
  return numbers.length
    ? `${by || "Someone"} declared a major incident and linked ${listTicketNumbers(numbers)}.`
    : `${by || "Someone"} declared a major incident.`;
}

/** "#1052, #1051 and #1049"; past six, "#1052, #1051, … and 4 more". */
export function listTicketNumbers(numbers: number[]): string {
  const n = numbers.map((x) => `#${x}`);
  if (n.length <= 1) return n[0] ?? "";
  if (n.length <= 6) return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  return `${n.slice(0, 5).join(", ")} and ${n.length - 5} more`;
}

/** "sent to 34 requesters and shown in Get help" under each update. */
export function sentLine(sent: number, banner: IncidentBanner): string {
  const shown = banner !== "off";
  if (sent === 0) return shown ? "shown in Get help" : "no linked tickets to tell";
  const to = `sent to ${sent} ${sent === 1 ? "requester" : "requesters"}`;
  return shown ? `${to} and shown in Get help` : to;
}

// --- The auto-link rule --------------------------------------------------------

/** The rule's terms: comma-separated, trimmed, lower-cased, up to five. */
export function ruleTerms(match: string): string[] {
  return [
    ...new Set(
      match
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, INCIDENT_LIMITS.terms);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` (a new ticket's subject and opening message) contain one of
 * the rule's terms? Case-insensitive, and a term must start a word: "vpn"
 * matches "VPN down" and "the vpn's slow" but not "openvpn". Pure.
 */
export function matchesRule(text: string, match: string): boolean {
  // Under three letters ("vp") would catch half the queue; a rule stored before the limit ignores them.
  const terms = ruleTerms(match).filter((t) => t.length >= 3);
  if (!terms.length || !text) return false;
  return terms.some((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, "iu").test(text));
}

// --- Input checks ----------------------------------------------------------------

export interface DeclareInput {
  title: string;
  team_id: number | null;
  priority: "low" | "normal" | "high" | "urgent";
  numbers: number[];
  match_text: string;
  banner: IncidentBanner;
  notify_on_link: boolean;
}

export class IncidentInputError extends Error {}

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

function ticketNumbers(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new IncidentInputError("Send the tickets as a list of numbers.");
  if (raw.length > INCIDENT_LIMITS.link) throw new IncidentInputError(`Up to ${INCIDENT_LIMITS.link} tickets at a time.`);
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^#?\d{1,9}$/.test(v.trim()) ? Number(v.trim().replace("#", "")) : NaN;
    if (!Number.isInteger(n) || n <= 0) throw new IncidentInputError("Ticket numbers only, like 1051.");
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The auto-link rule as typed: trimmed, at most five terms of 60 characters. Throws IncidentInputError. */
export function cleanMatch(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string" || raw.length > INCIDENT_LIMITS.match) throw new IncidentInputError(`Keep the words to match under ${INCIDENT_LIMITS.match} characters.`);
  const terms = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (terms.length > INCIDENT_LIMITS.terms) throw new IncidentInputError(`Up to ${INCIDENT_LIMITS.terms} words or phrases, separated by commas.`);
  if (terms.some((t) => t.length > INCIDENT_LIMITS.term)) throw new IncidentInputError(`Each word or phrase can be up to ${INCIDENT_LIMITS.term} characters.`);
  if (terms.some((t) => t.length < 3)) throw new IncidentInputError("Match words of three letters or more.");
  return terms.join(", ");
}

export function cleanTitle(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!t) throw new IncidentInputError("Give the incident a title people will recognise.");
  if (t.length > INCIDENT_LIMITS.title) throw new IncidentInputError(`Keep the title under ${INCIDENT_LIMITS.title} characters.`);
  return t;
}

export function cleanBanner(raw: unknown, fallback: IncidentBanner = "workspace"): IncidentBanner {
  if (raw === undefined || raw === null) return fallback;
  if (raw === true) return "workspace";
  if (raw === false) return "off";
  if (typeof raw === "string" && (INCIDENT_BANNERS as readonly string[]).includes(raw)) return raw as IncidentBanner;
  throw new IncidentInputError("The Get help banner is workspace, team or off.");
}

/** Parse and check a declare body. Throws IncidentInputError. */
export function validateDeclare(raw: Record<string, unknown>): DeclareInput {
  const title = cleanTitle(raw.title);
  let team_id: number | null = null;
  if (raw.team_id !== undefined && raw.team_id !== null) {
    const n = Number(raw.team_id);
    if (!Number.isInteger(n) || n <= 0) throw new IncidentInputError("Choose a team.");
    team_id = n;
  }
  const priority = raw.priority === undefined ? "urgent" : raw.priority;
  if (!(PRIORITIES as readonly unknown[]).includes(priority)) throw new IncidentInputError("Unknown priority.");
  if (raw.notify_on_link !== undefined && typeof raw.notify_on_link !== "boolean") throw new IncidentInputError("notify_on_link must be true or false.");
  return {
    title,
    team_id,
    priority: priority as DeclareInput["priority"],
    numbers: ticketNumbers(raw.numbers),
    match_text: cleanMatch(raw.match_text),
    banner: cleanBanner(raw.banner),
    notify_on_link: raw.notify_on_link !== false,
  };
}

export function validateNumbers(raw: unknown): number[] {
  const n = ticketNumbers(raw);
  if (!n.length) throw new IncidentInputError("Choose at least one ticket.");
  return n;
}

export function cleanUpdate(raw: unknown, opts: { allowEmpty?: boolean } = {}): string {
  const b = typeof raw === "string" ? raw.trim() : "";
  if (!b && !opts.allowEmpty) throw new IncidentInputError("Write the update first.");
  if (b.length > INCIDENT_LIMITS.update) throw new IncidentInputError(`Keep an update under ${INCIDENT_LIMITS.update} characters.`);
  return b;
}

// --- What the routes answer ------------------------------------------------------

export interface IncidentRefusal {
  number: number;
  reason: string;
}

export interface IncidentUpdateView {
  id: number;
  body: string;
  author_name: string;
  sent_count: number;
  created_at: string;
}

export interface IncidentLinkedRow {
  number: number;
  subject: string;
  requester_name: string;
  status: string;
  team_name: string | null;
  via: IncidentLinkVia;
  linked_at: string;
  /** The viewer works this ticket (opens it, unlinks it). */
  can_work: boolean;
}

/** The incident as its ticket's pane shows it (agents who work the incident's ticket). */
export interface IncidentView {
  id: number;
  number: number;
  title: string;
  subject: string;
  team_id: number | null;
  team_name: string | null;
  priority: string;
  open: boolean;
  declared_by_name: string;
  declared_at: string;
  match_text: string;
  banner: IncidentBanner;
  notify_on_link: boolean;
  /** Every linked ticket, whichever team. */
  linked_total: number;
  /** Linked tickets still open (an update reaches these). */
  linked_open: number;
  /** The linked tickets the viewer works; the rest are counted in hidden. */
  linked: IncidentLinkedRow[];
  hidden: number;
  updates: IncidentUpdateView[];
  me_too: number;
  affected: number;
  /** incidents.manage in the incident's team, and replies go out directly. */
  can_manage: boolean;
  /** Why can_manage is false while the role has incidents.manage (newbie review), else null. */
  manage_note: string | null;
  can_link: boolean;
  status_page: IncidentStatusPage | null;
}

/** The Status page card: shown when the board has an internal (manual) service and the viewer may post on it. */
export interface IncidentStatusPage {
  services: { id: number; name: string }[];
  service_id: number | null;
  service_name: string | null;
  can_manage: boolean;
}

/** A linked ticket's side of it. */
export interface IncidentLinkView {
  incident: { id: number; number: number; title: string; open: boolean; team_name: string | null };
  via: IncidentLinkVia;
  linked_at: string;
  linked_by_name: string | null;
  can_unlink: boolean;
  /** The viewer works the incident's own ticket (the link opens it). */
  can_open: boolean;
}

export type IncidentForTicket =
  | { role: "incident"; incident: IncidentView }
  | { role: "linked"; link: IncidentLinkView }
  | { role: null };

/** The desk nav's "Major incidents" group and the link picker. */
export interface IncidentNavItem {
  id: number;
  number: number;
  title: string;
  team_name: string | null;
  linked_open: number;
  /** The viewer works the incident's ticket. */
  can_open: boolean;
}

/** A queue row's chip. */
export type IncidentChip = { kind: "incident"; linked: number } | { kind: "linked"; number: number };

/** A Get help banner (requester-safe: no ticket numbers, no agent names). */
export interface IncidentBannerView {
  id: number;
  title: string;
  message: string;
  team_name: string | null;
  last_update_at: string;
  affected: number;
  me_too: boolean;
}

/** The per-ticket outcome of linking, unlinking or solving. */
export interface IncidentTicketResult {
  number: number;
  ok: boolean;
  error?: string;
}
