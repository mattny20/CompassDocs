// Helpdesk 1.19.1: the customer portal's shared rules (agent V6). Pure: the
// admin page, the portal pages and the server (lib/helpdesk/portal) read
// one set of definitions. Safe in client components.
//
// The portal lives at the fixed path /support. Its session cookie is
// PORTAL_COOKIE, scoped to that path (so a browser never sends it to /api
// or any app page) and separate from the app's compass_session: a portal
// session is never a workspace session and the reverse.

/** The portal's fixed path. A configurable segment is out of scope for 1.19.1. */
export const PORTAL_PATH = "/support";
/** The portal's own API, under its path (the cookie never leaves PORTAL_PATH). */
export const PORTAL_API = `${PORTAL_PATH}/api`;
/** The portal session cookie: its own name, Path=/support, HttpOnly, SameSite=Lax. */
export const PORTAL_COOKIE = "compass_portal";

/** What asking for a link always answers (allowed or not, known or not). */
export const PORTAL_LINK_SENT = "If that address can use this portal, a sign-in link is on its way. Check your email.";

/** One-time sign-in links last this long. */
export const PORTAL_LINK_TTL_MS = 15 * 60_000;
/** Sessions last this long since the last visit (sliding). */
export const PORTAL_SESSION_TTL_MS = 30 * 24 * 3_600_000;

export type PortalAccess = "anyone" | "domains";

export interface PortalExposedType {
  /** hd_request_types.id */
  id: number;
  /** The team portal requests of this type go to; null = the type's own team. */
  team_id: number | null;
}

export interface PortalLimits {
  /** Sign-in links one address may ask for in an hour. */
  links_per_email_hour: number;
  /** New requests one contact may raise in an hour. */
  requests_per_email_hour: number;
}

export interface PortalSettings {
  enabled: boolean;
  types: PortalExposedType[];
  access: PortalAccess;
  /** Approved domains (access "domains"): "clientco.com" also admits "eu.clientco.com". */
  domains: string[];
  brand_name: string;
  /** The stored upload name of the logo (lib/uploads), "" for initials. */
  brand_logo: string;
  limits: PortalLimits;
  /** Words that refuse a new request or reply (whole words, case-insensitive). */
  blocked_words: string[];
  /** Domains that may never sign in, whatever the access rule. */
  blocked_domains: string[];
}

export const PORTAL_LIMIT_BOUNDS = {
  links_per_email_hour: { min: 1, max: 20, default: 5 },
  requests_per_email_hour: { min: 1, max: 50, default: 5 },
} as const;

export const PORTAL_TEXT_LIMITS = {
  brandName: 80,
  domains: 200,
  domain: 253,
  words: 200,
  word: 60,
  name: 120,
  email: 254,
} as const;

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  enabled: false,
  types: [],
  access: "anyone",
  domains: [],
  brand_name: "",
  brand_logo: "",
  limits: {
    links_per_email_hour: PORTAL_LIMIT_BOUNDS.links_per_email_hour.default,
    requests_per_email_hour: PORTAL_LIMIT_BOUNDS.requests_per_email_hour.default,
  },
  blocked_words: [],
  blocked_domains: [],
};

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]+$/;

/** A clean, lower-case address, or null when it is not one. */
export function cleanEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > PORTAL_TEXT_LIMITS.email || !EMAIL_RE.test(v)) return null;
  return v;
}

/**
 * The mailbox an address reaches, for per-address limits and blocks
 * (1.19.1 review): lower-case, with a "+tag" dropped from the local part,
 * so "Bob+1@x.com" and "bob@x.com" count as one. Mail still goes to the
 * address as given. The SQL twin is portal.ts MAILBOX_SQL (same pattern).
 */
export function canonicalMailbox(email: string): string {
  return email.trim().toLowerCase().replace(/^([^+@]+)\+[^@]*@/, "$1@");
}

/** "Clientco.com", "@clientco.com" and " clientco.com " are the same domain; null when not one. */
export function cleanDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(v) ? v : null;
}

export function domainOfEmail(email: string): string {
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase() : "";
}

/** The address's domain is the listed one or under it ("eu.clientco.com" is under "clientco.com"). */
export function domainMatches(domain: string, list: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return list.some((x) => d === x || d.endsWith(`.${x}`));
}

/** May this address use the portal, by the access rule and the blocked domains? */
export function emailAllowed(email: string, s: Pick<PortalSettings, "access" | "domains" | "blocked_domains">): boolean {
  const d = domainOfEmail(email);
  if (!d) return false;
  if (domainMatches(d, s.blocked_domains)) return false;
  if (s.access === "domains") return domainMatches(d, s.domains);
  return true;
}

/** The first blocked word the text holds (whole word, case-insensitive), or null. */
export function blockedWordIn(text: string, words: readonly string[]): string | null {
  if (!words.length || !text) return null;
  const hay = text.toLowerCase();
  for (const w of words) {
    const needle = w.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      const before = i === 0 ? "" : hay[i - 1];
      const after = hay[i + needle.length] ?? "";
      const edge = (c: string) => !c || !/[\p{L}\p{N}_]/u.test(c);
      if (edge(before) && edge(after)) return w;
      from = i + 1;
    }
  }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function clampInt(v: unknown, b: { min: number; max: number; default: number }): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return b.default;
  return Math.min(b.max, Math.max(b.min, Math.round(n)));
}

function cleanList(raw: unknown, max: number, each: (s: unknown) => string | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const v = each(x);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Settings as stored or as sent, cleaned to the shape (unknown keys
 * dropped, lists de-duplicated, limits clamped). Never throws: a stored
 * value that predates a key reads as the default.
 */
export function cleanPortalSettings(raw: unknown): PortalSettings {
  const v = isObj(raw) ? raw : {};
  const lim = isObj(v.limits) ? v.limits : {};
  const types: PortalExposedType[] = [];
  if (Array.isArray(v.types)) {
    for (const t of v.types) {
      if (!isObj(t)) continue;
      const id = Number(t.id);
      if (!Number.isInteger(id) || id <= 0 || types.some((x) => x.id === id)) continue;
      const team = t.team_id === null || t.team_id === undefined || t.team_id === "" ? null : Number(t.team_id);
      types.push({ id, team_id: team !== null && Number.isInteger(team) && team > 0 ? team : null });
      if (types.length >= 100) break;
    }
  }
  return {
    enabled: v.enabled === true,
    types,
    access: v.access === "domains" ? "domains" : "anyone",
    domains: cleanList(v.domains, PORTAL_TEXT_LIMITS.domains, cleanDomain),
    brand_name: typeof v.brand_name === "string" ? v.brand_name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PORTAL_TEXT_LIMITS.brandName) : "",
    brand_logo: typeof v.brand_logo === "string" && /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(v.brand_logo) ? v.brand_logo : "",
    limits: {
      links_per_email_hour: clampInt(lim.links_per_email_hour, PORTAL_LIMIT_BOUNDS.links_per_email_hour),
      requests_per_email_hour: clampInt(lim.requests_per_email_hour, PORTAL_LIMIT_BOUNDS.requests_per_email_hour),
    },
    blocked_words: cleanList(v.blocked_words, PORTAL_TEXT_LIMITS.words, (x) =>
      typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, PORTAL_TEXT_LIMITS.word) || null : null
    ),
    blocked_domains: cleanList(v.blocked_domains, PORTAL_TEXT_LIMITS.domains, cleanDomain),
  };
}

/** "Acme Support" → "AS"; the header's tile when there is no logo. */
export function brandInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`).toUpperCase();
}

/** Why a request type can't be offered to outside customers (blockers), as the admin page words them. */
export type PortalBlocker = "inactive" | "restricted" | "person_field" | "manager_approval" | "space_approval" | "directory_condition" | "directory_route";

export const PORTAL_BLOCKER_TEXT: Record<PortalBlocker, string> = {
  inactive: "The request type is switched off.",
  restricted: "Only some groups in your organisation can use it.",
  person_field: "Its form asks for a person from your directory.",
  manager_approval: "Its workflow asks the requester's manager to approve.",
  space_approval: "Its workflow grants access to a space.",
  directory_condition: "Its workflow reads the requester's directory entry.",
  directory_route: "Its workflow routes by the requester's directory entry.",
};

/** A path inside the portal that a sign-in link may land on; anything else is the portal's home. */
export function cleanNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  if (!/^\/support(\/[A-Za-z0-9/_-]*)?$/.test(v) || v.includes("//") || v.startsWith(`${PORTAL_API}`)) return "";
  return v.slice(0, 200);
}

/** "Priya Shah" → "Priya": what a customer reads of an agent. */
export function firstName(name: string): string {
  const t = name.trim().split(/\s+/)[0] ?? "";
  return t.slice(0, 60);
}
