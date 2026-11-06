// Helpdesk 1.19.2: Status page services per team (agent W6), as data and
// pure functions. The desk's top-bar pill, pop-ups, queue banner and the
// team settings (client) and lib/helpdesk/status-teams (server) share this
// module, so the rules the server applies and what the screens say cannot
// drift. No server imports here.

import type { ServiceStatus } from "../status-parsers";

export type { ServiceStatus };

/** When a team's agents get a pop-up for a service. */
export const POPUP_LEVELS = ["degraded", "outage", "off"] as const;
export type PopupLevel = (typeof POPUP_LEVELS)[number];

export const POPUP_LEVEL_LABEL: Record<PopupLevel, string> = {
  degraded: "Outage and degraded",
  outage: "Outage only",
  off: "Off (banner only)",
};

export function isPopupLevel(v: unknown): v is PopupLevel {
  return typeof v === "string" && (POPUP_LEVELS as readonly string[]).includes(v);
}

/** The states that count as trouble: the pill counts them, the queue banner shows them. */
export function isAffected(status: string): status is "degraded" | "outage" {
  return status === "degraded" || status === "outage";
}

/**
 * The one recovery predicate (sync, solve asks, declaring): operational, or
 * in planned maintenance. "unknown" (a feed that never answered) is neither
 * trouble nor recovery.
 */
export function isRecovered(status: string): boolean {
  return status === "operational" || status === "maintenance";
}

/** Trouble ranks: none < degraded < outage. */
export function troubleRank(level: string): number {
  return level === "outage" ? 2 : level === "degraded" ? 1 : 0;
}

/** Does a team with this pop-up level get a pop-up for a spell whose worst state is `worst`? */
export function popupApplies(level: PopupLevel, worst: string): boolean {
  if (level === "off") return false;
  return troubleRank(worst) >= (level === "outage" ? 2 : 1);
}

export const STATE_LABEL: Record<ServiceStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
};

export function stateLabel(s: string): string {
  return (STATE_LABEL as Record<string, string>)[s] ?? "Unknown";
}

/** Chip tone per state (components/Chip tones). */
export function stateTone(s: string): "ok" | "warn" | "error" | "info" | "neutral" {
  return s === "operational" ? "ok" : s === "degraded" ? "warn" : s === "outage" ? "error" : s === "maintenance" ? "info" : "neutral";
}

/** "is degraded" / "is down" / "is operational again". */
export function stateSentence(s: string): string {
  if (s === "outage") return "is down";
  if (s === "degraded") return "is degraded";
  if (s === "operational") return "is operational again";
  if (s === "maintenance") return "is under maintenance";
  return "has an unknown state";
}

// --- Suggestions for a major incident declared from a service ------------------------

/** Words tickets about well-known services tend to use (the rule matches at a word start). */
const ALIASES: [RegExp, string[]][] = [
  [/\b(microsoft 365|office 365|m365|o365|exchange)\b/i, ["mail", "email", "outlook"]],
  [/\bgoogle workspace\b|\bg ?suite\b/i, ["gmail", "google", "drive"]],
  [/\bokta\b/i, ["okta", "sign in", "sso"]],
  [/\bentra\b|\bazure ad\b/i, ["sign in", "mfa", "sso"]],
  [/\bteams\b/i, ["teams"]],
  [/\bjira\b|\batlassian\b/i, ["jira", "confluence"]],
];

const STOP = new Set(["internal", "the", "and", "of", "for", "service", "services", "status", "online", "app", "apps", "inc", "ltd", "cloud", "platform", "system", "systems"]);

/** The shortest word W1's auto-link rule matches and accepts (incidents-shared matchesRule, cleanMatch). */
export const MIN_RULE_WORD = 3;

/** Up to three words for "link new tickets automatically" from a service's name. */
export function suggestWords(name: string): string[] {
  for (const [re, words] of ALIASES) if (re.test(name)) return words.filter((w) => w.length >= MIN_RULE_WORD).slice(0, 5);
  const out: string[] = [];
  for (const raw of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_RULE_WORD || /^\d+$/.test(raw) || STOP.has(raw) || out.includes(raw)) continue;
    out.push(raw);
    if (out.length === 3) break;
  }
  return out;
}

/** The incident's title people will see, from the service and its state. */
export function suggestTitle(name: string, state: string): string {
  return `${name} ${state === "outage" ? "is down" : "is degraded"}`.slice(0, 200);
}

// --- What the routes answer ------------------------------------------------------

export interface TeamStatusService {
  id: number;
  name: string;
  provider: string;
  status: ServiceStatus;
  detail: string;
  url: string;
  changed_at: string | null;
  checked_at: string | null;
  /** The agent's teams that follow it. */
  team_ids: number[];
}

export interface TeamStatusPopup {
  kind: "down" | "recovered";
  episode_id: number;
  service_id: number;
  service_name: string;
  /** The service's state now. */
  state: ServiceStatus;
  detail: string;
  started_at: string;
  ended_at: string | null;
  /** The team the pop-up is for (one the agent belongs to that follows the service). */
  team_id: number;
  team_name: string;
  /** May run major incidents in that team (W1's incidents.manage, replies without review). */
  can_declare: boolean;
  /** Open tickets in that team since it started that mention the service (down only). */
  mentions: number;
  mention_word: string;
  /** An open major incident already declared for this service: link to it instead of offering to declare. */
  incident: StatusIncidentRef | null;
}

export interface StatusIncidentRef {
  number: number;
  title: string;
}

export interface TeamStatusBanner {
  episode_id: number;
  team_id: number;
  service_id: number;
  service_name: string;
  state: ServiceStatus;
  detail: string;
  started_at: string;
  can_declare: boolean;
  incident: StatusIncidentRef | null;
}

/** A major incident declared from a service that is operational again: solve it? */
export interface TeamStatusAsk {
  incident_id: number;
  number: number;
  title: string;
  service_name: string;
  /** The service's state now (operational or maintenance). */
  state: ServiceStatus;
  team_id: number | null;
  linked_open: number;
}

export interface TeamStatusView {
  now: string;
  /** Last time a vendor feed among the agent's services was checked (null: internal services only). */
  checked_at: string | null;
  teams: { id: number; name: string; can_manage: boolean }[];
  /** teams.manage: may open Desk settings → Teams. */
  manage_all: boolean;
  services: TeamStatusService[];
  popups: TeamStatusPopup[];
  banners: TeamStatusBanner[];
  asks: TeamStatusAsk[];
  /** This poll started a sync in the background: ask again in a few seconds for its result. */
  syncing?: boolean;
}

/** Per-person marks: a pop-up dismissed, a recovery note dismissed, a banner hidden, "Not now" on a solve ask. */
export type SeenAction = "dismiss" | "dismiss_recovery" | "hide_banner" | "dismiss_ask";

export interface TeamStatusSettingsRow {
  id: number;
  name: string;
  provider: string;
  status: ServiceStatus;
  detail: string;
  followed: boolean;
  popup_level: PopupLevel;
}

export interface DeclarePrefill {
  service: { id: number; name: string; state: ServiceStatus; detail: string };
  team_id: number;
  since: string;
  title: string;
  words: string[];
  tickets: { number: number; subject: string; team_id: number | null }[];
}

/** Validate a PUT of a team's services. Throws Error with a sentence for the API's 400. */
export function validateTeamServices(raw: unknown): { service_id: number; popup_level: PopupLevel }[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { services?: unknown }).services) ? (raw as { services: unknown[] }).services : null;
  if (!list) throw new Error("Send the services as a list.");
  if (list.length > 200) throw new Error("Up to 200 services.");
  const out: { service_id: number; popup_level: PopupLevel }[] = [];
  const seen = new Set<number>();
  for (const it of list) {
    const o = (it ?? {}) as { service_id?: unknown; popup_level?: unknown };
    const id = Number(o.service_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Each service needs its id.");
    const level = o.popup_level === undefined ? "degraded" : o.popup_level;
    if (!isPopupLevel(level)) throw new Error("Pop-up for is outage and degraded, outage only, or off.");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ service_id: id, popup_level: level });
  }
  return out;
}
