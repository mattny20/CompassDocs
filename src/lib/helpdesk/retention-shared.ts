// Helpdesk 1.19.1: retention and privacy (agent V5, mock-up #6), the pure
// half: the settings' shape, defaults and validation, shared by the page
// and the server (lib/helpdesk/retention).
//
// Stored as one JSON value under the settings key `helpdesk_retention`;
// a read fills every missing field from the defaults.
//
// Owner decision (1.19.1): nothing destructive happens on upgrade. Closing
// solved tickets and the anonymise-or-delete period are both OFF until an
// admin turns them on here; a stored value without the switches reads as
// off. Account-removal anonymisation stays on by default.

export const HD_RETENTION_KEY = "helpdesk_retention";

export type HdRetentionUnit = "months" | "years";
export type HdRetentionAction = "anonymise" | "delete";

export interface HdRetentionSettings {
  /** Close solved tickets automatically (off by default). */
  auto_close_enabled: boolean;
  /** Solved tickets close after this many days without a reply. */
  auto_close_days: number;
  /** Anonymise or delete closed tickets after the retention period (off by default). */
  retention_enabled: boolean;
  /** Closed tickets are kept this long (keep_amount keep_unit) after they closed… */
  keep_amount: number;
  keep_unit: HdRetentionUnit;
  /** …then anonymised (kept for reports) or deleted. */
  action: HdRetentionAction;
  /** Removing an account anonymises that person's tickets as requester and CC. */
  anonymise_on_account_removal: boolean;
  /** A person's data export includes their requests and the public conversation. */
  include_in_export: boolean;
}

export const HD_RETENTION_DEFAULTS: HdRetentionSettings = {
  auto_close_enabled: false,
  auto_close_days: 7,
  retention_enabled: false,
  keep_amount: 3,
  keep_unit: "years",
  action: "anonymise",
  anonymise_on_account_removal: true,
  include_in_export: true,
};

export const HD_RETENTION_LIMITS = {
  autoCloseDays: { min: 1, max: 365 },
  months: { min: 1, max: 240 },
  years: { min: 1, max: 20 },
} as const;

/** What anonymising writes in place of a requester's or a CC's name. */
export const HD_FORMER_REQUESTER = "Former requester";

/** Fill and clamp a stored value. Never throws. */
export function normalizeRetention(raw: unknown): HdRetentionSettings {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = HD_RETENTION_DEFAULTS;
  const int = (x: unknown, min: number, max: number, fallback: number) =>
    typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : fallback;
  const unit: HdRetentionUnit = v.keep_unit === "months" ? "months" : v.keep_unit === "years" ? "years" : d.keep_unit;
  const lim = HD_RETENTION_LIMITS[unit];
  return {
    auto_close_enabled: v.auto_close_enabled === true,
    retention_enabled: v.retention_enabled === true,
    auto_close_days: int(v.auto_close_days, HD_RETENTION_LIMITS.autoCloseDays.min, HD_RETENTION_LIMITS.autoCloseDays.max, d.auto_close_days),
    keep_amount: int(v.keep_amount, lim.min, lim.max, unit === d.keep_unit ? d.keep_amount : Math.min(lim.max, unit === "months" ? 36 : 3)),
    keep_unit: unit,
    action: v.action === "delete" ? "delete" : v.action === "anonymise" ? "anonymise" : d.action,
    anonymise_on_account_removal: v.anonymise_on_account_removal === undefined ? d.anonymise_on_account_removal : v.anonymise_on_account_removal === true,
    include_in_export: v.include_in_export === undefined ? d.include_in_export : v.include_in_export === true,
  };
}

/** Check a patch from the page: an error sentence for the first bad field, else null. */
export function retentionPatchError(patch: Record<string, unknown>): string | null {
  const known = new Set(Object.keys(HD_RETENTION_DEFAULTS));
  for (const k of Object.keys(patch)) if (!known.has(k)) return `There is no retention setting called "${k}".`;
  const a = HD_RETENTION_LIMITS.autoCloseDays;
  if ("auto_close_days" in patch) {
    const n = patch.auto_close_days;
    if (typeof n !== "number" || !Number.isInteger(n) || n < a.min || n > a.max) return `Close solved tickets after ${a.min} to ${a.max} days.`;
  }
  if ("keep_unit" in patch && patch.keep_unit !== "months" && patch.keep_unit !== "years") return "Keep closed tickets for months or years.";
  if ("keep_amount" in patch) {
    const unit = (patch.keep_unit ?? "years") as HdRetentionUnit;
    const lim = HD_RETENTION_LIMITS[unit === "months" ? "months" : "years"];
    const n = patch.keep_amount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < lim.min || n > lim.max) return `Keep closed tickets for ${lim.min} to ${lim.max} ${unit}.`;
  }
  if ("action" in patch && patch.action !== "anonymise" && patch.action !== "delete") return "After that, anonymise or delete.";
  for (const k of ["auto_close_enabled", "retention_enabled", "anonymise_on_account_removal", "include_in_export"] as const) {
    if (k in patch && typeof patch[k] !== "boolean") return "Switches are on or off.";
  }
  return null;
}

/** The instant before which a closed ticket is due: `now` less the retention period (calendar months). */
export function retentionCutoff(s: Pick<HdRetentionSettings, "keep_amount" | "keep_unit">, now: Date): Date {
  const months = s.keep_unit === "years" ? s.keep_amount * 12 : s.keep_amount;
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  // Clamp to the month's last day (Mar 31 less one month is Feb 28, not Mar 3).
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** The instant before which a solved ticket closes. */
export function autoCloseCutoff(s: Pick<HdRetentionSettings, "auto_close_days">, now: Date): Date {
  return new Date(now.getTime() - s.auto_close_days * 86_400_000);
}

/** A ticket in the preview list. */
export interface HdRetentionItem {
  id: number;
  number: number;
  subject: string;
  team_name: string | null;
  /** When it was solved (close) or closed (anonymise, delete). */
  since: string | null;
  what: "close" | "anonymise" | "delete";
}

/** The dry run: what the next run would do. */
export interface HdRetentionPlan {
  /** Which rules are on (a rule that is off touches nothing). */
  enabled: { close: boolean; purge: boolean };
  /** When the next run is (the sweep runs once a night). */
  run_at: string;
  close_before: string;
  purge_before: string;
  action: HdRetentionAction;
  counts: { close: number; anonymise: number; delete: number; held: number };
  /** The first tickets of each kind (the "See the list" dialog). */
  items: HdRetentionItem[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tonight: 41 tickets close, 312 are anonymised (closed before Nov 2023). Nothing is deleted." */
export function planSentence(p: Pick<HdRetentionPlan, "counts" | "purge_before" | "action"> & Partial<Pick<HdRetentionPlan, "enabled">>): string {
  if (p.enabled && !p.enabled.close && !p.enabled.purge) {
    return "Both rules are off, so nothing is closed, anonymised or deleted. Turn one on to see what the next run would do.";
  }
  const n = (x: number, one: string, many: string) => `${x.toLocaleString("en-GB")} ${x === 1 ? one : many}`;
  const before = new Date(p.purge_before);
  const when = `${MONTHS[before.getUTCMonth()]} ${before.getUTCFullYear()}`;
  const parts: string[] = [];
  if (p.counts.close) parts.push(`${n(p.counts.close, "ticket closes", "tickets close")}`);
  if (p.counts.anonymise) parts.push(`${p.counts.anonymise.toLocaleString("en-GB")} ${p.counts.anonymise === 1 ? "is" : "are"} anonymised (closed before ${when})`);
  if (p.counts.delete) parts.push(`${p.counts.delete.toLocaleString("en-GB")} ${p.counts.delete === 1 ? "is" : "are"} deleted (closed before ${when})`);
  const head = parts.length ? `Tonight: ${parts.join(", ")}.` : "Tonight: nothing to close, anonymise or delete.";
  const tail = p.counts.delete ? "" : parts.length ? " Nothing is deleted." : "";
  const held = p.counts.held ? ` ${n(p.counts.held, "ticket is", "tickets are")} on legal hold and kept.` : "";
  return `${head}${tail}${held}`;
}
