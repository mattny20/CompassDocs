import "server-only";
import { cache } from "react";
import { getSetting, setSetting } from "./db";
import { audit } from "./audit";
import type { AuditActor } from "./audit";

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
// card. Deadlines and Reminders (E1/E2), the typed-signature toggle (C2),
// Annual re-confirmation (G1) and Evidence (F2/C5) add their keys here when
// they ship; `ack_report` is read with its default now so the sweeps have one
// place to look, but the API refuses to write it until F2's card exists.

export const EDIT_DEFAULTS = ["ask", "material", "reset"] as const;
/** What a policy does when its text changes: ask the editor each time, ask
 *  only when the change looks material, or always ask everyone to re-confirm. */
export type EditDefault = (typeof EDIT_DEFAULTS)[number];

export interface AckDefaults {
  /** The per-document default a policy receives when it is first set to
   *  require read confirmation (A5, `documents.ack_edit_default`). */
  edit_default: EditDefault;
  /** Whether an editorial fix needs a change note as well as a material
   *  change (A3's keep path reads it; the material note is always required). */
  keep_reason_required: boolean;
}

export interface AckReportSettings {
  enabled: boolean;
  cadence: "weekly" | "monthly";
  recipients: { users: number[]; groups: number[] };
}

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
  ack_defaults: { edit_default: "ask", keep_reason_required: true },
  compliance_statement_default: "I confirm that I have read and understood this document.",
  ack_report: { enabled: false, cadence: "weekly", recipients: { users: [], groups: [] } },
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
  return {
    edit_default: isEditDefault(raw?.edit_default) ? raw.edit_default : d.edit_default,
    keep_reason_required:
      typeof raw?.keep_reason_required === "boolean" ? raw.keep_reason_required : d.keep_reason_required,
  };
}

function idList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
}

function normaliseReport(raw: Record<string, unknown> | null): AckReportSettings {
  const d = COMPLIANCE_DEFAULTS.ack_report;
  const recipients = raw?.recipients && typeof raw.recipients === "object" ? (raw.recipients as Record<string, unknown>) : null;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : d.enabled,
    cadence: raw?.cadence === "monthly" ? "monthly" : "weekly",
    recipients: { users: idList(recipients?.users), groups: idList(recipients?.groups) },
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
}

export type PatchResult = { ok: true; patch: ComplianceSettingsPatch } | { ok: false; error: string };

const ACK_DEFAULT_KEYS = new Set<keyof AckDefaults>(["edit_default", "keep_reason_required"]);
const TOP_KEYS = new Set<keyof ComplianceSettingsPatch>(["ack_defaults", "compliance_statement_default"]);

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

  for (const change of changes) {
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
