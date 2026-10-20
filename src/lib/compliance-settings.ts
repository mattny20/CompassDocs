import "server-only";
import { cache } from "react";
import { getSetting, setSetting } from "./db";
import { audit } from "./audit";
import type { AuditActor } from "./audit";
import { isRecertDefault, RECERT_OPTIONS } from "./ack-recert";
import { DUE_NUMBER_KEYS, dueNumberError, isDueNumber } from "./ack-due";
import type { DueNumberKey } from "./ack-due";

// Program settings (E4, 1.10.1): the documented defaults every policy
// inherits, edited on /compliance/settings and read by the features that
// honour them. Three rows in the settings table: `ack_defaults` (one JSON
// object), `compliance_statement_default` (text) and `ack_report` (JSON).
// Nothing is written until an admin saves, and a key that is absent or
// unreadable falls back to COMPLIANCE_DEFAULTS, which reproduce the
// behaviour the product had before the page existed.
//
// Each card on the page ships with the item that reads its values, so the
// page never shows a control nothing honours. In 1.10.1 that is the Editing
// card (read by A5's per-document default) and the Confirmation statement
// card; 1.12.0 adds the Re-confirmation card (G1: `ack_defaults.recert_months`,
// the interval a policy receives when it is first set to required). Deadlines
// and Reminders (E1/E2), the typed-signature toggle (C2) and Evidence (F2/C5)
// add their keys here when they ship; `ack_report` is read with its default
// now so the sweeps have one place to look, but the API refuses to write it
// until F2's card exists.

export const EDIT_DEFAULTS = ["ask", "material", "reset"] as const;
/** What a policy does when its text changes: ask the editor each time, ask
 *  only when the change looks material, or always ask everyone to re-confirm. */
export type EditDefault = (typeof EDIT_DEFAULTS)[number];

/**
 * The workspace layer of the deadline cascade (E1/E2, 1.13.0): the seven
 * numbers of lib/ack-due, each null when the workspace keeps the built-in.
 * A policy inherits them through policy_settings -> spaces.policy_defaults
 * -> here -> BUILT_IN (resolvePolicyDefaults in lib/compliance).
 */
export type AckDueDefaults = { [K in DueNumberKey]: number | null };

/** Every due number unset: what a workspace has until an admin types one. */
const NO_DUE_DEFAULTS = Object.fromEntries(DUE_NUMBER_KEYS.map((k) => [k, null])) as AckDueDefaults;

export interface AckDefaults extends AckDueDefaults {
  /** The per-document default a policy receives when it is first set to
   *  require read confirmation (A5, `documents.ack_edit_default`). */
  edit_default: EditDefault;
  /** Whether an editorial fix needs a change note as well as a material
   *  change (A3's keep path reads it; the material note is always required). */
  keep_reason_required: boolean;
  /** "Re-confirm every" (G1): the interval a policy receives when it is first
   *  set to require read confirmation (setAckRequired); null = no cycle. One
   *  of RECERT_OPTIONS (null, 6, 12 or 24); a policy may set any 1..60 for itself. */
  recert_months: number | null;
  /** "Group leads see policy standing" (F4, 1.14.0): whether leading a group
   *  (group_leads) opens /compliance/team and the Policies section of the
   *  weekly digest for that group's members, within the lead's own space
   *  scope. compliance.team_read opens them regardless. Widening what every
   *  existing lead can see is a permissions change, so a workspace that had
   *  an ack_defaults row before 1.14.0 reads it as OFF until an admin turns
   *  it on; a workspace with no row yet (a new install) reads it as ON. */
  leads_see_policies: boolean;
}

/**
 * The scheduled programme report (F2, 1.14.0): whether it goes out, weekly
 * (the first tick of each ISO week) or monthly (with the monthly snapshot),
 * and to whom (user ids; the route refuses an id that is not an active
 * account). Read by lib/compliance-audit's weeklyComplianceReport and
 * monthlyComplianceEvidence, edited through GET/PUT /api/admin/compliance/report.
 */
export interface AckReportSettings {
  enabled: boolean;
  cadence: "weekly" | "monthly";
  recipients: number[];
}

/** The most recipients a report takes. */
export const REPORT_RECIPIENTS_MAX = 50;

export interface ComplianceSettings {
  ack_defaults: AckDefaults;
  /** The sentence on the end-of-article card; C2 lets a policy override it. */
  compliance_statement_default: string;
  ack_report: AckReportSettings;
}

/** The longest statement the card can carry as one sentence. */
export const STATEMENT_MAX = 300;

/** The same sentence `AckCard` has shipped since 1.10.0 (its
 *  DEFAULT_CONFIRMATION_STATEMENT); kept as a literal here because the card
 *  is a client component and this module is server-only. */
export const COMPLIANCE_DEFAULTS: ComplianceSettings = {
  ack_defaults: { edit_default: "ask", keep_reason_required: true, recert_months: null, leads_see_policies: true, ...NO_DUE_DEFAULTS },
  compliance_statement_default: "I confirm that I have read and understood this document.",
  ack_report: { enabled: false, cadence: "weekly", recipients: [] },
};

// --- Reading --------------------------------------------------------------------

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isEditDefault(v: unknown): v is EditDefault {
  return typeof v === "string" && (EDIT_DEFAULTS as readonly string[]).includes(v);
}

/** One sentence on one line: runs of whitespace collapse, ends are trimmed. */
export function normaliseStatement(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function normaliseAckDefaults(raw: Record<string, unknown> | null): AckDefaults {
  const d = COMPLIANCE_DEFAULTS.ack_defaults;
  // A due number out of its range (a hand edit of 0 or 400 days) reads as
  // unset, so the cascade moves on to the built-in rather than apply it.
  const due = Object.fromEntries(DUE_NUMBER_KEYS.map((k) => [k, isDueNumber(k, raw?.[k]) ? raw![k] : null])) as AckDueDefaults;
  return {
    ...due,
    edit_default: isEditDefault(raw?.edit_default) ? raw.edit_default : d.edit_default,
    keep_reason_required:
      typeof raw?.keep_reason_required === "boolean" ? raw.keep_reason_required : d.keep_reason_required,
    // Absent reads as the default (no cycle); so does a value the build does
    // not offer (a hand edit of 7), as edit_default treats an unknown mode.
    recert_months: raw && "recert_months" in raw && isRecertDefault(raw.recert_months) ? raw.recert_months : d.recert_months,
    // Decided from the presence of the stored row (F4): no row (or an
    // unreadable one) is a workspace that never saved program settings, which
    // gets the default (on); a row without the key is an upgraded workspace,
    // whose leads keep seeing what they saw (off) until an admin opts in.
    leads_see_policies:
      typeof raw?.leads_see_policies === "boolean" ? raw.leads_see_policies : raw === null ? d.leads_see_policies : false,
  };
}

function idList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
}

function normaliseReport(raw: Record<string, unknown> | null): AckReportSettings {
  const d = COMPLIANCE_DEFAULTS.ack_report;
  // A list of user ids since 1.14.0; the {users, groups} shape the key was
  // reserved with before then reads as its users.
  const recipients = Array.isArray(raw?.recipients)
    ? idList(raw.recipients)
    : raw?.recipients && typeof raw.recipients === "object"
      ? idList((raw.recipients as Record<string, unknown>).users)
      : [];
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : d.enabled,
    cadence: raw?.cadence === "monthly" ? "monthly" : "weekly",
    recipients: [...new Set(recipients.filter((n) => n > 0))].slice(0, REPORT_RECIPIENTS_MAX),
  };
}

/** The settings as stored, with COMPLIANCE_DEFAULTS filling every key that
 *  is absent or unreadable. Uncached: the route's PUT reads it before and
 *  after a save, and the test reads it after each write. */
export async function readComplianceSettings(): Promise<ComplianceSettings> {
  const [defaultsRaw, statement, reportRaw] = await Promise.all([
    getSetting("ack_defaults"),
    getSetting("compliance_statement_default"),
    getSetting("ack_report"),
  ]);
  return {
    ack_defaults: normaliseAckDefaults(parseJsonObject(defaultsRaw)),
    compliance_statement_default:
      normaliseStatement(statement) || COMPLIANCE_DEFAULTS.compliance_statement_default,
    ack_report: normaliseReport(parseJsonObject(reportRaw)),
  };
}

/** The settings, read once per request (React cache): a page, the sweeps
 *  and a document's first set-to-required all ask this and share the answer. */
export const getComplianceSettings = cache(readComplianceSettings);

// --- Writing --------------------------------------------------------------------

/** What PUT /api/admin/compliance/settings accepts: only the keys whose
 *  cards exist. Partial on purpose: a save sends what it owns. */
export interface ComplianceSettingsPatch {
  ack_defaults?: Partial<AckDefaults>;
  compliance_statement_default?: string;
  /** The report block (F2): any subset; the recipients list replaces the stored one. */
  ack_report?: Partial<AckReportSettings>;
}

export type PatchResult = { ok: true; patch: ComplianceSettingsPatch } | { ok: false; error: string };

const ACK_DEFAULT_KEYS = new Set<keyof AckDefaults>(["edit_default", "keep_reason_required", "recert_months", "leads_see_policies", ...DUE_NUMBER_KEYS]);
const isDueKey = (k: string): k is DueNumberKey => (DUE_NUMBER_KEYS as readonly string[]).includes(k);
/** "6, 12 or 24" for the error line, from the options the Select offers. */
const RECERT_DEFAULT_LIST = RECERT_OPTIONS.filter((o) => o.months !== null)
  .map((o) => String(o.months))
  .reduce((acc, m, i, all) => (i === 0 ? m : i === all.length - 1 ? `${acc} or ${m}` : `${acc}, ${m}`), "");
const TOP_KEYS = new Set<keyof ComplianceSettingsPatch>(["ack_defaults", "compliance_statement_default", "ack_report"]);
const REPORT_KEYS = new Set<keyof AckReportSettings>(["enabled", "cadence", "recipients"]);

/**
 * Validate the report block (F2): `enabled` a boolean, `cadence` weekly or
 * monthly, `recipients` a list of up to REPORT_RECIPIENTS_MAX user ids
 * (duplicates collapse). Pure; whether each id is an active account is
 * checked by validateReportRecipients at save time. Used by
 * parseComplianceSettingsPatch and by PUT /api/admin/compliance/report.
 */
export function parseAckReportPatch(value: unknown): { ok: true; patch: Partial<AckReportSettings> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: '"ack_report" must be an object.' };
  }
  const patch: Partial<AckReportSettings> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!REPORT_KEYS.has(k as keyof AckReportSettings)) {
      return { ok: false, error: `Unknown setting "ack_report.${k}".` };
    }
    if (k === "enabled") {
      if (typeof v !== "boolean") return { ok: false, error: '"ack_report.enabled" must be true or false.' };
      patch.enabled = v;
    } else if (k === "cadence") {
      if (v !== "weekly" && v !== "monthly") return { ok: false, error: '"ack_report.cadence" must be weekly or monthly.' };
      patch.cadence = v;
    } else if (k === "recipients") {
      if (!Array.isArray(v) || v.some((n) => !Number.isInteger(n) || (n as number) <= 0)) {
        return { ok: false, error: '"ack_report.recipients" must be a list of user ids.' };
      }
      const ids = [...new Set(v as number[])];
      if (ids.length > REPORT_RECIPIENTS_MAX) {
        return { ok: false, error: `Choose up to ${REPORT_RECIPIENTS_MAX} recipients.` };
      }
      patch.recipients = ids;
    }
  }
  return { ok: true, patch };
}

/**
 * The recipients must be active accounts (a report goes to people who can
 * act on it, never to a disabled or deleted account). Answers the sentence
 * a route returns as its 400, or null when every id is fine.
 */
export async function validateReportRecipients(ids: readonly number[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const { listUsers } = await import("./db");
  const active = new Set((await listUsers()).filter((u) => u.status === "active").map((u) => u.id));
  return ids.every((id) => active.has(id)) ? null : "Every recipient must be an active account.";
}

/**
 * Validate a request body. Every key is checked and an unknown one is
 * refused rather than ignored, so a typo in a client (or a key from a card
 * that has not shipped yet) never saves silently. Pure: the route and the
 * test call it the same way.
 */
export function parseComplianceSettingsPatch(body: unknown): PatchResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object of settings." };
  }
  const patch: ComplianceSettingsPatch = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!TOP_KEYS.has(key as keyof ComplianceSettingsPatch)) {
      return { ok: false, error: `Unknown setting "${key}".` };
    }
    if (key === "ack_defaults") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: '"ack_defaults" must be an object.' };
      }
      const inner: Partial<AckDefaults> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!ACK_DEFAULT_KEYS.has(k as keyof AckDefaults)) {
          return { ok: false, error: `Unknown setting "ack_defaults.${k}".` };
        }
        if (k === "edit_default") {
          if (!isEditDefault(v)) {
            return { ok: false, error: '"ack_defaults.edit_default" must be ask, material or reset.' };
          }
          inner.edit_default = v;
        } else if (k === "keep_reason_required") {
          if (typeof v !== "boolean") {
            return { ok: false, error: '"ack_defaults.keep_reason_required" must be true or false.' };
          }
          inner.keep_reason_required = v;
        } else if (k === "leads_see_policies") {
          if (typeof v !== "boolean") {
            return { ok: false, error: '"ack_defaults.leads_see_policies" must be true or false.' };
          }
          inner.leads_see_policies = v;
        } else if (k === "recert_months") {
          if (!isRecertDefault(v)) {
            return { ok: false, error: `"ack_defaults.recert_months" must be ${RECERT_DEFAULT_LIST} months, or null for never.` };
          }
          inner.recert_months = v;
        } else if (isDueKey(k)) {
          // null = the built-in (the field left blank on the card).
          if (v !== null && !isDueNumber(k, v)) return { ok: false, error: dueNumberError(k, "ack_defaults.") };
          inner[k] = v;
        }
      }
      patch.ack_defaults = inner;
    } else if (key === "compliance_statement_default") {
      if (typeof value !== "string") {
        return { ok: false, error: '"compliance_statement_default" must be text.' };
      }
      const text = normaliseStatement(value);
      if (!text) return { ok: false, error: "Enter a confirmation statement." };
      if (text.length > STATEMENT_MAX) {
        return { ok: false, error: `Keep the statement under ${STATEMENT_MAX} characters.` };
      }
      patch.compliance_statement_default = text;
    } else if (key === "ack_report") {
      const report = parseAckReportPatch(value);
      if (!report.ok) return report;
      patch.ack_report = report.patch;
    }
  }
  return { ok: true, patch };
}

/** One audit row per key whose value changed: {key, from, to}. Nested keys
 *  are dotted ("ack_defaults.edit_default"). */
export interface ComplianceSettingChange {
  key: string;
  from: unknown;
  to: unknown;
}

/**
 * Persist a validated patch and write one `settings.compliance` audit row
 * per changed key (a key sent with the value it already has is not a
 * change). `ack_defaults` is merged over the stored object, so a key a newer
 * build wrote survives a save from an older one, and a key never saved stays
 * absent and keeps following COMPLIANCE_DEFAULTS.
 */
export async function saveComplianceSettings(
  patch: ComplianceSettingsPatch,
  by: { actor?: AuditActor | null; ip?: string | null } = {}
): Promise<{ settings: ComplianceSettings; changes: ComplianceSettingChange[] }> {
  const before = await readComplianceSettings();
  const changes: ComplianceSettingChange[] = [];

  if (patch.ack_defaults) {
    for (const k of Object.keys(patch.ack_defaults) as (keyof AckDefaults)[]) {
      const to = patch.ack_defaults[k];
      if (to !== undefined && to !== before.ack_defaults[k]) {
        changes.push({ key: `ack_defaults.${k}`, from: before.ack_defaults[k], to });
      }
    }
    if (changes.length) {
      const stored = parseJsonObject(await getSetting("ack_defaults")) ?? {};
      await setSetting("ack_defaults", JSON.stringify({ ...stored, ...patch.ack_defaults }));
    }
  }

  // The parser already normalised a request body; a direct caller may not
  // have, and an empty sentence is never stored (it would read as the default).
  const statement =
    patch.compliance_statement_default === undefined
      ? undefined
      : normaliseStatement(patch.compliance_statement_default) || undefined;
  if (statement !== undefined && statement !== before.compliance_statement_default) {
    changes.push({ key: "compliance_statement_default", from: before.compliance_statement_default, to: statement });
    await setSetting("compliance_statement_default", statement);
  }

  // The report block (F2): merged over what is stored, like ack_defaults;
  // the recipients list is compared as a set.
  if (patch.ack_report) {
    const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));
    const reportChanges: ComplianceSettingChange[] = [];
    for (const k of Object.keys(patch.ack_report) as (keyof AckReportSettings)[]) {
      const to = patch.ack_report[k];
      if (to === undefined) continue;
      const from = before.ack_report[k];
      const same = k === "recipients" ? sameIds(from as number[], to as number[]) : from === to;
      if (!same) reportChanges.push({ key: `ack_report.${k}`, from, to });
    }
    if (reportChanges.length) {
      changes.push(...reportChanges);
      await setSetting("ack_report", JSON.stringify({ ...before.ack_report, ...patch.ack_report }));
    }
  }

  for (const change of changes) {
    if (change.key.startsWith("ack_report.")) {
      // The report's own key (F2), so the Evidence surfaces filter on it.
      await audit({
        actor: by.actor,
        action: "ack.report_settings",
        targetType: "setting",
        targetId: change.key,
        targetLabel: change.key,
        details: { key: change.key.slice("ack_report.".length), from: change.from, to: change.to },
        ip: by.ip,
      });
      continue;
    }
    const dueKey = change.key.startsWith("ack_defaults.") ? change.key.slice("ack_defaults.".length) : "";
    if (isDueKey(dueKey)) {
      // The deadline cascade's workspace layer (E1): the same action a
      // space's layer writes, so one filter shows every default that moved.
      await audit({
        actor: by.actor,
        action: "ack.defaults_set",
        targetType: "setting",
        targetId: change.key,
        targetLabel: change.key,
        details: { scope: "workspace", space_id: null, key: dueKey, from: change.from, to: change.to },
        ip: by.ip,
      });
      continue;
    }
    await audit({
      actor: by.actor,
      action: "settings.compliance",
      targetType: "setting",
      targetId: change.key,
      targetLabel: change.key,
      details: { key: change.key, from: change.from, to: change.to },
      ip: by.ip,
    });
  }

  return { settings: await readComplianceSettings(), changes };
}
