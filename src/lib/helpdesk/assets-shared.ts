// Helpdesk 1.19.3: assets on tickets, client-safe (shapes, choices, checks
// and wording the desk and the server share). Server code is
// lib/helpdesk/assets; the source clients are lib/helpdesk/assets/*.
//
// A source ("provider") is where devices come from. 1.19.3 has one,
// Snipe-IT; the provider registry (lib/helpdesk/assets/providers) takes a
// second (Intune, 1.19.4) without changing any caller: every caller asks by
// provider key and reads the same HdAsset shape.

export type HdAssetProviderKey = "snipeit";

export const HD_ASSET_PROVIDER_LABEL: Record<string, string> = {
  snipeit: "Snipe-IT",
};

/** The label of a provider key (a test's stamped key reads as its base). */
export function providerLabel(key: string): string {
  return HD_ASSET_PROVIDER_LABEL[key] ?? HD_ASSET_PROVIDER_LABEL[key.split(":")[0]] ?? key;
}

/** What happens in the source when a ticket with a linked asset is solved. */
export type HdAssetOnSolve = "nothing" | "offer_maintenance";
export const HD_ASSET_ON_SOLVE: readonly HdAssetOnSolve[] = ["nothing", "offer_maintenance"];

/** Snipe-IT's maintenance types (asset_maintenance_type takes the value as written). */
export const SNIPEIT_MAINTENANCE_TYPES: readonly { value: string; label: string }[] = [
  { value: "Maintenance", label: "Maintenance" },
  { value: "Repair", label: "Repair" },
  { value: "Upgrade", label: "Upgrade" },
  { value: "Software Support", label: "Software support" },
  { value: "Hardware Support", label: "Hardware support" },
  { value: "Configuration Change", label: "Configuration change" },
  { value: "PAT test", label: "PAT test" },
  { value: "Calibration", label: "Calibration" },
];
export const DEFAULT_MAINTENANCE_TYPE = "Repair";

export const ASSET_LIMITS = {
  /** Assets linked to one ticket. */
  perTicket: 10,
  /** Picker and search results. */
  results: 20,
  /** A search query. */
  q: 120,
  /** A maintenance note (Snipe-IT keeps notes as text). */
  note: 2000,
  /** Snipe-IT's maintenance title. */
  title: 100,
} as const;

/** The desk's shape of one asset (the cache row, never the raw source record). */
export interface HdAsset {
  id: number;
  provider: string;
  provider_label: string;
  tag: string;
  serial: string;
  name: string;
  model: string;
  category: string;
  status_label: string;
  /** deployed | deployable | pending | undeployable | archived | "" (the source's own meaning). */
  status_kind: string;
  assigned_name: string;
  assigned_email: string;
  location: string;
  /** YYYY-MM-DD or null. */
  purchase_date: string | null;
  warranty_end: string | null;
  url: string;
  synced_at: string;
  /** Missing from the source's latest sync (deleted or archived there). */
  gone: boolean;
}

/** An asset linked to a ticket, as the side card shows it. */
export interface HdLinkedAsset extends HdAsset {
  linked_by_name: string;
  linked_at: string;
  /** Tickets opened before this one that the asset is linked to (counted whatever the viewer may open). */
  earlier_tickets: number;
}

/** GET /api/helpdesk/tickets/[number]/assets */
export interface HdTicketAssetsView {
  /** A source is set up (or assets are already linked). */
  configured: boolean;
  assets: HdLinkedAsset[];
  can_edit: boolean;
  requester: { name: string; email: string } | null;
  /** Agents may search every asset (Desk settings → Assets). */
  search_all: boolean;
}

/** GET /api/helpdesk/tickets/[number]/assets/solve: present when solving offers to log a maintenance record. */
export interface HdSolveOffer {
  provider_label: string;
  assets: { id: number; name: string; tag: string }[];
  types: readonly { value: string; label: string }[];
  suppliers: { id: number; name: string }[];
  /** The note's starting text ("CompassDocs #1047."). */
  note: string;
}

/** One row of the link picker. */
export interface HdAssetOption {
  id: number;
  name: string;
  tag: string;
  serial: string;
  category: string;
  model: string;
  provider_label: string;
  assigned_name: string;
  linked: boolean;
}

/** GET /api/helpdesk/tickets/[number]/assets/options */
export interface HdAssetOptions {
  assigned: HdAssetOption[];
  results: HdAssetOption[];
  search_all: boolean;
  /** A live lookup in the source failed (the cached list is shown). */
  notice: string | null;
}

export interface HdMaintenanceRecord {
  id: string;
  type: string;
  title: string;
  notes: string;
  supplier: string;
  /** YYYY-MM-DD */
  start_date: string | null;
  completion_date: string | null;
}

/** GET /api/helpdesk/assets/[id] */
export interface HdAssetPage {
  asset: HdAsset;
  tickets: {
    number: number;
    subject: string;
    requester_name: string;
    status: string;
    created_at: string;
    minutes: number;
  }[];
  /** Linked tickets the viewer may not open (counted, never named). */
  hidden_tickets: number;
  /** Records the viewer may read: ones naming no ticket, or only tickets they may open. */
  maintenance: HdMaintenanceRecord[] | null;
  /** Records naming a ticket the viewer may not open, or an anonymised one (counted, never shown). */
  hidden_maintenance: number;
  /** Why maintenance (or a fresh read) could not be fetched; the page shows the cached details. */
  notice: string | null;
}

/** Desk settings → Assets (GET /api/helpdesk/admin/assets). The key itself is never sent. */
export interface HdAssetSettingsView {
  snipeit: {
    url: string;
    key_set: boolean;
    on_solve: HdAssetOnSolve;
    sync: HdAssetSyncState;
  };
  agents_search_all: boolean;
}

export interface HdAssetSyncState {
  /** The last sync that finished (ok or not). */
  at: string | null;
  ok: boolean | null;
  error: string;
  /** Assets in the cache from this source. */
  count: number;
  running: boolean;
}

// --- Checks -----------------------------------------------------------------------------

/**
 * A Snipe-IT address as an admin types it: https only, no user name or
 * password, no query; a pasted "/api/v1" and a trailing slash are dropped.
 */
export function checkSnipeItUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: true, value: "" };
  if (s.length > 300) return { ok: false, error: "Keep the address under 300 characters." };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { ok: false, error: "Enter the Snipe-IT address, like https://assets.example.com." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Use an https:// address. Snipe-IT's API key would otherwise travel unencrypted." };
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address." };
  if (u.search || u.hash) return { ok: false, error: "Leave the ? and # parts out of the address." };
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return { ok: false, error: "Enter the full host name, like assets.example.com." };
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "").replace(/\/+$/, "");
  return { ok: true, value: `${u.origin}${path}` };
}

/** An API key as pasted: one line, a sensible length. */
export function checkApiKey(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof raw === "string" ? raw.trim().replace(/^Bearer\s+/i, "") : "";
  if (!s) return { ok: false, error: "Paste the API key." };
  if (s.length > 4096 || /\s/.test(s)) return { ok: false, error: "That doesn't look like a Snipe-IT API key. Paste the whole key on one line." };
  return { ok: true, value: s };
}

// --- Wording ----------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2027" from YYYY-MM-DD; "" for nothing. */
export function monthYear(date: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`.trim() : "";
}

/** "Sep 15" (this year) or "Sep 15, 2025" from YYYY-MM-DD. */
export function dayMonth(date: string | null | undefined, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  if (!m) return "";
  const base = `${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
  return Number(m[1]) === now.getFullYear() ? base : `${base}, ${m[1]}`;
}

/** The warranty line: "Until Mar 2027", "Ended Mar 2024" or "". */
export function warrantyLabel(end: string | null | undefined, now: Date = new Date()): string {
  const my = monthYear(end);
  if (!my) return "";
  return `${String(end) < now.toISOString().slice(0, 10) ? "Ended" : "Until"} ${my}`;
}

/** The status as people say it: a checked-out asset is "Deployed" whatever its label. */
export function statusText(a: Pick<HdAsset, "status_kind" | "status_label">): string {
  if (a.status_kind === "deployed") return "Deployed";
  return a.status_label || (a.status_kind ? a.status_kind[0].toUpperCase() + a.status_kind.slice(1) : "");
}

/** The chip tone of a status. */
export function statusTone(kind: string): "ok" | "info" | "warn" | "neutral" {
  if (kind === "deployed") return "ok";
  if (kind === "deployable") return "info";
  if (kind === "pending") return "warn";
  return "neutral";
}

export type HdAssetIcon = "laptop" | "desktop" | "monitor" | "phone" | "tablet" | "printer" | "other";

/** Which picture an asset gets, from its category and model. */
export function assetIcon(a: Pick<HdAsset, "category" | "model" | "name">): HdAssetIcon {
  const s = `${a.category} ${a.model} ${a.name}`.toLowerCase();
  if (/laptop|notebook|macbook|thinkpad|latitude|elitebook|surface laptop/.test(s)) return "laptop";
  if (/phone|iphone|android|pixel|galaxy s|mobile/.test(s)) return "phone";
  if (/tablet|ipad/.test(s)) return "tablet";
  if (/monitor|display|screen/.test(s)) return "monitor";
  if (/printer|scanner/.test(s)) return "printer";
  if (/desktop|workstation|imac|mac mini|optiplex|tower/.test(s)) return "desktop";
  return "other";
}

/** "3 earlier tickets on this asset". */
export function earlierTicketsLabel(n: number): string {
  return n === 1 ? "1 earlier ticket on this asset" : `${n} earlier tickets on this asset`;
}

/** The maintenance note's starting text. */
export function maintenanceNotePrefill(number: number): string {
  return `CompassDocs #${number}.`;
}

/** The note as sent: the ticket number is always in it ("The ticket number is added"). */
export function noteWithTicket(note: string, number: number): string {
  const n = note.trim().slice(0, ASSET_LIMITS.note - 24);
  if (new RegExp(`#${number}(?!\\d)`).test(n)) return n;
  return n ? `${n}${/[.!?]$/.test(n) ? "" : "."} CompassDocs #${number}.` : `CompassDocs #${number}.`;
}

/**
 * The maintenance title Snipe-IT shows in its list: the ticket number and
 * the type, never the subject (everyone who can open the asset, here or in
 * Snipe-IT, reads it, and retention can't reach it there).
 */
export function maintenanceTitle(number: number, typeLabel: string): string {
  return `CompassDocs #${number}: ${typeLabel}`.slice(0, ASSET_LIMITS.title);
}

/** The ticket numbers a maintenance record names ("#1047"), in its title or notes. */
export function ticketRefs(text: string): number[] {
  return [...new Set([...text.matchAll(/#(\d{1,9})(?!\d)/g)].map((m) => Number(m[1])))];
}

/** The label of a Snipe-IT maintenance type value. */
export function maintenanceTypeLabel(value: string): string {
  return SNIPEIT_MAINTENANCE_TYPES.find((t) => t.value.toLowerCase() === value.toLowerCase())?.label ?? value;
}
