// Helpdesk 1.19.0: contact cards, the client-safe half. The card an agent
// sees for the person who asked (and anyone else on the ticket), and the
// card a requester sees for the agent helping them, are both built from the
// CompassDocs directory: an admin maps directory fields to the card's slots
// once (Desk settings, Contact cards), and picks what each side sees.
//
// This module holds the types, the defaults, the sanitiser the settings
// route saves through, and the pure link builders (tel:, Teams, Webex,
// Slack) and local-time formatting, so the settings page, the card and the
// tests read one set of rules. lib/helpdesk/contact-cards is the server
// half (directory reads, visibility, VIP, access).

import type { HdAvailability } from "./types";

// --- Settings ------------------------------------------------------------------

/** The parts of a card either side can be shown. */
export const HD_CARD_PARTS = [
  "photo",
  "pronouns",
  "title",
  "department",
  "office",
  "local_time",
  "manager",
  "desk_phone",
  "cell_phone",
  "email",
  "teams",
  "webex",
  "slack",
  "extra",
  "team",
  "availability",
  "presence",
  "profile",
  "vcard",
] as const;
export type HdCardPart = (typeof HD_CARD_PARTS)[number];

export const HD_CARD_PART_LABEL: Record<HdCardPart, string> = {
  photo: "Photo",
  pronouns: "Pronouns",
  title: "Job title",
  department: "Department",
  office: "Office",
  local_time: "Local time",
  manager: "Manager",
  desk_phone: "Desk phone",
  cell_phone: "Cell phone",
  email: "Email",
  teams: "Teams",
  webex: "Webex",
  slack: "Slack",
  extra: "Extra fields",
  team: "Desk team and role",
  availability: "Desk availability",
  presence: "Teams presence",
  profile: "Directory profile link",
  vcard: "Save contact (.vcf)",
};

/** What a requester sees on the agent's card unless an admin changes it: no phones. */
export const HD_REQUESTER_SEES_DEFAULT: HdCardPart[] = [
  "photo",
  "pronouns",
  "title",
  "office",
  "local_time",
  "email",
  "teams",
  "webex",
  "slack",
  "team",
  "availability",
  "presence",
  "profile",
];
/** What an agent sees on a requester's card: everything mapped. */
export const HD_AGENT_SEES_DEFAULT: HdCardPart[] = [...HD_CARD_PARTS];

/** The directory-field slots of a card. Values are directory field keys ("" = not shown). */
export interface HdCardFieldMap {
  desk_phone: string;
  cell_phone: string;
  email: string;
  office: string;
  department: string;
  title: string;
  /** A people field ("Reports to"). */
  manager: string;
  pronouns: string;
  /** A person field holding an IANA time zone ("Europe/London"); "" = from the office. */
  timezone: string;
}
export type HdCardSlot = keyof HdCardFieldMap;

export const HD_CARD_SLOT_LABEL: Record<HdCardSlot, string> = {
  desk_phone: "Desk phone",
  cell_phone: "Cell phone",
  email: "Email",
  office: "Office",
  department: "Department",
  title: "Job title",
  manager: "Manager",
  pronouns: "Pronouns",
  timezone: "Time zone",
};

export const HD_CARD_FIELDS_DEFAULT: HdCardFieldMap = {
  desk_phone: "phone",
  cell_phone: "mobile",
  email: "email",
  office: "office",
  department: "department",
  title: "title",
  manager: "manager",
  pronouns: "",
  timezone: "",
};

export type HdTeamsMode = "microsoft" | "everyone" | "field" | "off";
export type HdWebexMode = "off" | "email" | "field";
export type HdSlackMode = "off" | "field";
export type HdVipRule = "off" | "field" | "marker";

export interface HdVipEntry {
  kind: "user" | "group" | "department";
  user_id?: number;
  group_id?: number;
  department?: string;
  /** Shown to agents beside the chip: "Board member", "Travels a lot". */
  note: string;
}

export interface HdContactCardSettings {
  fields: HdCardFieldMap;
  /** Teams: Microsoft-synced people by email/UPN (default), everyone with an email, a field holding the UPN, or off. */
  teams: { mode: HdTeamsMode; field: string };
  /** Webex: a field holding a Webex address (or a *.webex.com room link), the email, or off. */
  webex: { mode: HdWebexMode; field: string };
  /** Slack: a field holding the member ID (U…), the workspace's domain and team ID for links. */
  slack: { mode: HdSlackMode; field: string; domain: string; team_id: string };
  /** Up to six more directory fields shown under the contact lines. */
  extra: string[];
  vip: {
    rule: HdVipRule;
    /** rule "field": the field and the value that makes someone a VIP ("" = any value). */
    field: string;
    value: string;
    /** rule "marker": a directory export marker (Directory, Export, Markers). */
    marker_id: string;
    /** The helpdesk's own VIP list, on top of the rule. */
    list: HdVipEntry[];
  };
  /** Office (as the directory names it, lower-case) → IANA time zone. */
  office_timezones: Record<string, string>;
  requester_sees: HdCardPart[];
  agent_sees: HdCardPart[];
}

export const HD_CONTACT_CARDS_KEY = "helpdesk_contact_cards";
export const HD_CARD_EXTRA_MAX = 6;
export const HD_VIP_LIST_MAX = 500;
export const HD_VIP_NOTE_MAX = 120;
export const HD_OFFICE_TZ_MAX = 200;

export function defaultContactCardSettings(): HdContactCardSettings {
  return {
    fields: { ...HD_CARD_FIELDS_DEFAULT },
    teams: { mode: "microsoft", field: "" },
    webex: { mode: "off", field: "" },
    slack: { mode: "off", field: "", domain: "", team_id: "" },
    extra: [],
    vip: { rule: "off", field: "", value: "", marker_id: "", list: [] },
    office_timezones: {},
    requester_sees: [...HD_REQUESTER_SEES_DEFAULT],
    agent_sees: [...HD_AGENT_SEES_DEFAULT],
  };
}

export function validTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const FIELD_KEY = /^[a-z0-9_:]{1,64}$/;
const fieldKey = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return FIELD_KEY.test(s) ? s : "";
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  (allowed as readonly string[]).includes(String(v)) ? (v as T) : dflt;
const parts = (v: unknown, dflt: HdCardPart[]): HdCardPart[] =>
  Array.isArray(v) ? HD_CARD_PARTS.filter((p) => v.includes(p)) : [...dflt];

/** "acme", "acme.slack.com", "https://acme.slack.com/" → "acme"; "" when it is not a Slack domain. */
export function normalizeSlackDomain(raw: string): string {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.slack\.com$/, "");
  return /^[a-z0-9][a-z0-9-]{0,62}(\.enterprise)?$/.test(s) ? s : "";
}

export function normalizeSlackTeamId(raw: string): string {
  const s = String(raw ?? "").trim().toUpperCase();
  return /^[TE][A-Z0-9]{2,20}$/.test(s) ? s : "";
}

/**
 * Coerce untrusted JSON into settings. Field keys are shape-checked here;
 * keys that no longer exist in the directory are harmless (they read as
 * empty) and the settings page offers only real ones.
 */
export function sanitizeContactCardSettings(raw: unknown): HdContactCardSettings {
  const d = defaultContactCardSettings();
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const f = (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<string, unknown>;
  const fields = { ...d.fields };
  for (const k of Object.keys(fields) as HdCardSlot[]) if (f[k] !== undefined) fields[k] = fieldKey(f[k]);
  const t = (o.teams ?? {}) as Record<string, unknown>;
  const w = (o.webex ?? {}) as Record<string, unknown>;
  const s = (o.slack ?? {}) as Record<string, unknown>;
  const v = (o.vip ?? {}) as Record<string, unknown>;
  const extra = Array.isArray(o.extra) ? [...new Set(o.extra.map(fieldKey).filter(Boolean))].slice(0, HD_CARD_EXTRA_MAX) : [];

  const list: HdVipEntry[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(v.list) ? v.list : []) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    const note = String(x.note ?? "").replace(/\s+/g, " ").trim().slice(0, HD_VIP_NOTE_MAX);
    let entry: HdVipEntry | null = null;
    if (x.kind === "user" && Number.isSafeInteger(Number(x.user_id)) && Number(x.user_id) > 0) entry = { kind: "user", user_id: Number(x.user_id), note };
    else if (x.kind === "group" && Number.isSafeInteger(Number(x.group_id)) && Number(x.group_id) > 0) entry = { kind: "group", group_id: Number(x.group_id), note };
    else if (x.kind === "department") {
      const dep = String(x.department ?? "").trim().slice(0, 120);
      if (dep) entry = { kind: "department", department: dep, note };
    }
    if (!entry) continue;
    const id = `${entry.kind}:${entry.user_id ?? entry.group_id ?? entry.department!.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(entry);
    if (list.length >= HD_VIP_LIST_MAX) break;
  }

  const office_timezones: Record<string, string> = {};
  const tz = (o.office_timezones && typeof o.office_timezones === "object" ? o.office_timezones : {}) as Record<string, unknown>;
  for (const [k, val] of Object.entries(tz).slice(0, HD_OFFICE_TZ_MAX)) {
    const key = k.trim().toLowerCase().slice(0, 120);
    const zone = String(val ?? "").trim();
    if (key && validTimeZone(zone)) office_timezones[key] = zone;
  }

  return {
    fields,
    teams: { mode: pick(t.mode, ["microsoft", "everyone", "field", "off"] as const, d.teams.mode), field: fieldKey(t.field) },
    webex: { mode: pick(w.mode, ["off", "email", "field"] as const, d.webex.mode), field: fieldKey(w.field) },
    slack: {
      mode: pick(s.mode, ["off", "field"] as const, d.slack.mode),
      field: fieldKey(s.field),
      domain: normalizeSlackDomain(String(s.domain ?? "")),
      team_id: normalizeSlackTeamId(String(s.team_id ?? "")),
    },
    extra,
    vip: {
      rule: pick(v.rule, ["off", "field", "marker"] as const, d.vip.rule),
      field: fieldKey(v.field),
      value: String(v.value ?? "").trim().slice(0, 120),
      marker_id: String(v.marker_id ?? "").trim().slice(0, 60),
      list,
    },
    office_timezones,
    requester_sees: parts(o.requester_sees, d.requester_sees),
    agent_sees: parts(o.agent_sees, d.agent_sees),
  };
}

// --- The card ------------------------------------------------------------------

export interface HdCardPhone {
  kind: "desk" | "cell" | "other";
  label: string;
  value: string;
  /** "tel:+441612345678;ext=204"; "" when the value is not dialable. */
  tel_href: string;
}

export interface HdCardIm {
  kind: "teams" | "webex" | "slack";
  label: string;
  /** What the button opens: a web link (new tab) or an app link. */
  href: string;
  /** The desktop app's link where the service has one (msteams:, slack:). */
  app_href?: string;
  /** The address or ID, for copying. */
  value: string;
}

export type HdContactRelation = "requester" | "contact" | "approver" | "assignee" | "agent";

export const HD_CONTACT_RELATION_LABEL: Record<HdContactRelation, string> = {
  requester: "Requester",
  contact: "Contact",
  approver: "Approver",
  assignee: "Working on it",
  agent: "Replied",
};

export interface HdContactCard {
  user_id: number | null;
  directory_id: number | null;
  name: string;
  initials: string;
  photo_url: string | null;
  pronouns: string;
  title: string;
  department: string;
  office: { name: string; timezone: string | null; local_time: string | null; utc_offset: string | null } | null;
  manager: { name: string; directory_id: number | null } | null;
  /** Agents only; a requester-audience card always says { vip: false }. */
  vip: { vip: boolean; reason: string };
  /** Teams presence can be shown for this person (directory sync with presence on). */
  presence: boolean;
  phones: HdCardPhone[];
  email: string;
  im: HdCardIm[];
  extra: { key: string; label: string; value: string }[];
  /** /directory/<id>, when the viewer may read the directory. */
  profile_url: string | null;
  vcard_url: string | null;
  /** Data URL of the contact-card QR (scan to add to a phone); "" when not shown. */
  qr: string;
  /** Outlook "Schedule a meeting" for Microsoft-synced people; null otherwise. */
  calendar_href: string | null;
  /** The person's desk teams and role, when they are an agent. */
  team: { names: string[]; role_label: string } | null;
  availability: HdAvailability | null;
  /** Agents only: the person's other tickets the viewer can see. */
  earlier_tickets: {
    count: number;
    last_at: string | null;
    link: string;
    recent: { number: number; subject: string; status: string; created_at: string }[];
    /** Requester strip (1.20.3): how many of those are still open, and the newest of them. */
    open?: number;
    open_recent?: { number: number; subject: string }[];
    /** The rest (solved or closed): the newest of them, and when the last one was opened. */
    earlier_recent?: { number: number; subject: string; status: string; created_at: string }[];
    earlier_last_at?: string | null;
    /** Their satisfaction ratings on tickets the viewer can see (this one included); null when they never rated. */
    satisfaction?: { average: number; ratings: number } | null;
  } | null;
  /** How they are on this ticket. */
  relation: HdContactRelation;
  relation_label: string;
  /** Who the card was built for. */
  audience: "agent" | "requester";
  /** No directory entry: only the name and email. */
  minimal: boolean;
}

/** GET /api/helpdesk/contacts?ticket=<number>. */
export interface HdTicketContacts {
  audience: "agent" | "requester";
  contacts: HdContactCard[];
  /** The ticket's team, for "Your request is with the IT team". */
  team_name: string | null;
  /** Someone is assigned. */
  assigned: boolean;
}

// --- Links -----------------------------------------------------------------------

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function validEmail(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s);
}

/** "mailto:ana@example.com"; "" for anything that is not one address. */
export function mailtoHref(email: string): string {
  const e = String(email ?? "").trim();
  return validEmail(e) ? `mailto:${e}` : "";
}

/**
 * A dialable tel: link from a directory value: "+44 161 234 5678 x204" →
 * "tel:+441612345678;ext=204". Keeps a leading +, digits, and pause/wait
 * marks; "" when fewer than three digits remain.
 */
export function telHref(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = /^(.*?)(?:\s*(?:x|ext\.?|extension|#)\s*(\d{1,8}))?$/i.exec(raw);
  const main = m?.[1] ?? raw;
  const ext = m?.[2] ?? "";
  const plus = /^\s*\+/.test(main) ? "+" : "";
  const digits = main.replace(/[^0-9,;]/g, "");
  if (digits.replace(/[^0-9]/g, "").length < 3) return "";
  return `tel:${plus}${digits}${ext ? `;ext=${ext}` : ""}`;
}

/** Teams chat with someone by email/UPN: the web link and the app link. */
export function teamsLinks(upn: string): { href: string; app_href: string } | null {
  const u = String(upn ?? "").trim();
  if (!validEmail(u)) return null;
  const q = encodeURIComponent(u);
  return { href: `https://teams.microsoft.com/l/chat/0/0?users=${q}`, app_href: `msteams:/l/chat/0/0?users=${q}` };
}

/**
 * Webex from a directory value: a personal room link on webex.com
 * (https://acme.webex.com/meet/ana) opens as it is; an address (or a
 * sip: URI) opens a Webex chat in the app. null for anything else.
 */
export function webexLinks(value: string): { href: string; label: string; value: string } | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^https:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol === "https:" && (u.hostname === "webex.com" || u.hostname.endsWith(".webex.com")) && !u.username && !u.password) {
        return { href: u.toString(), label: "Webex room", value: u.toString() };
      }
    } catch {
      /* not a URL */
    }
    return null;
  }
  const addr = v.replace(/^sip:/i, "");
  if (!validEmail(addr)) return null;
  return { href: `webexteams://im?email=${encodeURIComponent(addr)}`, label: "Webex", value: addr };
}

/** A Slack member ID from "U012AB3CD", "<@U012AB3CD>" or a profile link; "" when there is none. */
export function slackMemberId(value: string): string {
  const v = String(value ?? "").trim();
  const m = /(?:^|[/@<])([UW][A-Z0-9]{2,20})>?$/.exec(v) ?? /^([UW][A-Z0-9]{2,20})$/.exec(v);
  return m ? m[1] : "";
}

/**
 * Slack profile links for a member ID: https://<domain>.slack.com/team/<id>
 * in the browser, slack://user?team=<T>&id=<U> in the app (when the team ID
 * is set). With no domain the app link is the only one. null without a
 * valid member ID or anywhere to open it.
 */
export function slackLinks(memberValue: string, domain: string, teamId: string): { href: string; app_href?: string; value: string } | null {
  const id = slackMemberId(memberValue);
  if (!id) return null;
  const d = normalizeSlackDomain(domain);
  const t = normalizeSlackTeamId(teamId);
  const app = t ? `slack://user?team=${encodeURIComponent(t)}&id=${encodeURIComponent(id)}` : undefined;
  if (d) return { href: `https://${d}.slack.com/team/${encodeURIComponent(id)}`, ...(app ? { app_href: app } : {}), value: id };
  if (app) return { href: app, value: id };
  return null;
}

/** "14:05" and "GMT+1" in a time zone; nulls for an unknown zone. */
export function localTimeIn(tz: string | null | undefined, now: Date = new Date()): { time: string; offset: string } | null {
  if (!tz || !validTimeZone(tz)) return null;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    offset = "";
  }
  return { time, offset };
}

/** "AB" from a name, for the photo's place. */
export function cardInitials(name: string): string {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}
