// Helpdesk 1.19.0: request types (what people pick in Get help) and their
// forms. Owned by the workflows module set (lib/helpdesk/workflows, engine,
// approvals): a request type links a form to a team and, optionally, a
// workflow whose published definition runs when someone sends the form.
//
// Validation is plain TypeScript, the codebase's way (no schema library):
// every function answers { ok: true, value } or { ok: false, error } with a
// sentence the settings page can show as is. Limits are deliberate and
// small: a form is something a person fills in, not a database.
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { slugify } from "../db";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { HD_PRIORITIES } from "./types";
import type {
  HdFormAnswers,
  HdFormField,
  HdFormFieldType,
  HdFormOption,
  HdPriority,
  HdRequestType,
} from "./types";

export const HD_FORM_FIELD_TYPES: readonly HdFormFieldType[] = [
  "choice",
  "text",
  "textarea",
  "date",
  "number",
  "user",
  "select",
  "checkbox",
];

/** The limits a form is checked against (the builder shows the same). */
export const FORM_LIMITS = {
  fields: 40,
  key: 40,
  label: 200,
  help: 500,
  options: 50,
  optionValue: 100,
  optionLabel: 200,
  optionHint: 200,
  defaultFrom: 100,
  text: 500,
  textarea: 10_000,
} as const;

export const REQUEST_TYPE_LIMITS = {
  title: 120,
  slug: 60,
  description: 500,
  icon: 40,
  category: 80,
  eta: 60,
  groups: 50,
} as const;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_RE = /^[a-z0-9-]*$/;
const DEFAULT_FROM_RE = /^directory:[a-z0-9_]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A real calendar date "YYYY-MM-DD" (no 2026-02-31). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const hasOptions = (t: HdFormFieldType) => t === "choice" || t === "select";

// --- Form definitions ----------------------------------------------------------------

/** Check a form definition (hd_request_types.form) and return it cleaned. */
export function validateFormFields(raw: unknown): Checked<HdFormField[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "The form must be a list of fields." };
  if (raw.length > FORM_LIMITS.fields) return { ok: false, error: `A form has at most ${FORM_LIMITS.fields} fields.` };
  const keys = new Set<string>();
  const out: HdFormField[] = [];
  for (const [i, f] of raw.entries()) {
    const n = i + 1;
    if (!isObj(f)) return { ok: false, error: `Field ${n} is not a field.` };
    const key = str(f.key);
    if (!key || key.length > FORM_LIMITS.key || !KEY_RE.test(key)) {
      return { ok: false, error: `Field ${n} needs a key of lower-case letters, digits and underscores (at most ${FORM_LIMITS.key}), starting with a letter.` };
    }
    if (keys.has(key)) return { ok: false, error: `Two fields use the key "${key}".` };
    keys.add(key);
    const label = str(f.label);
    if (!label || label.length > FORM_LIMITS.label) return { ok: false, error: `Field "${key}" needs a label (at most ${FORM_LIMITS.label} characters).` };
    const type = f.type as HdFormFieldType;
    if (!HD_FORM_FIELD_TYPES.includes(type)) return { ok: false, error: `Field "${key}" has an unknown type.` };
    const field: HdFormField = { key, label, type };
    if (f.required !== undefined && typeof f.required !== "boolean") return { ok: false, error: `Field "${key}": required is true or false.` };
    if (f.required) field.required = true;
    if (hasOptions(type)) {
      if (!Array.isArray(f.options) || f.options.length === 0) return { ok: false, error: `Field "${key}" needs at least one option.` };
      if (f.options.length > FORM_LIMITS.options) return { ok: false, error: `Field "${key}" has more than ${FORM_LIMITS.options} options.` };
      const values = new Set<string>();
      const options: HdFormOption[] = [];
      for (const o of f.options) {
        if (!isObj(o)) return { ok: false, error: `Field "${key}" has an option that is not an option.` };
        const value = str(o.value);
        const olabel = str(o.label) || value;
        const hint = str(o.hint);
        if (!value || value.length > FORM_LIMITS.optionValue) return { ok: false, error: `Field "${key}": every option needs a value (at most ${FORM_LIMITS.optionValue} characters).` };
        if (values.has(value)) return { ok: false, error: `Field "${key}" has two options with the value "${value}".` };
        if (olabel.length > FORM_LIMITS.optionLabel) return { ok: false, error: `Field "${key}": an option label is longer than ${FORM_LIMITS.optionLabel} characters.` };
        if (hint.length > FORM_LIMITS.optionHint) return { ok: false, error: `Field "${key}": an option hint is longer than ${FORM_LIMITS.optionHint} characters.` };
        values.add(value);
        options.push(hint ? { value, label: olabel, hint } : { value, label: olabel });
      }
      field.options = options;
    } else if (f.options !== undefined && !(Array.isArray(f.options) && f.options.length === 0)) {
      return { ok: false, error: `Field "${key}": only choice and select fields have options.` };
    }
    if (f.default_from !== undefined && f.default_from !== "" && f.default_from !== null) {
      const df = str(f.default_from);
      if (df.length > FORM_LIMITS.defaultFrom || !DEFAULT_FROM_RE.test(df)) {
        return { ok: false, error: `Field "${key}": default_from is "directory:<field key>".` };
      }
      field.default_from = df;
    }
    const help = str(f.help);
    if (help.length > FORM_LIMITS.help) return { ok: false, error: `Field "${key}": the help text is longer than ${FORM_LIMITS.help} characters.` };
    if (help) field.help = help;
    out.push(field);
  }
  return { ok: true, value: out };
}

// --- Answers -----------------------------------------------------------------------

/**
 * Check a requester's answers against a form and return them cleaned:
 * unknown keys dropped, empty optional answers left out, every value its
 * field's type. A user field must name an active account (checked here, one
 * query for all of them).
 */
export async function validateAnswers(form: HdFormField[], raw: unknown, client?: HdQueryable): Promise<Checked<HdFormAnswers>> {
  const given = isObj(raw) ? raw : {};
  const out: HdFormAnswers = {};
  const userIds: number[] = [];
  for (const f of form) {
    const v = given[f.key];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (f.type === "checkbox" && v === false);
    if (empty) {
      if (f.required) return { ok: false, error: `"${f.label}" is required.` };
      if (f.type === "checkbox" && v === false) out[f.key] = false;
      continue;
    }
    switch (f.type) {
      case "text":
      case "textarea": {
        if (typeof v !== "string") return { ok: false, error: `"${f.label}" must be text.` };
        const max = f.type === "text" ? FORM_LIMITS.text : FORM_LIMITS.textarea;
        const t = v.trim();
        if (t.length > max) return { ok: false, error: `"${f.label}" is longer than ${max} characters.` };
        out[f.key] = t;
        break;
      }
      case "date":
        if (!isIsoDate(v)) return { ok: false, error: `"${f.label}" must be a date.` };
        out[f.key] = v;
        break;
      case "number": {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
        if (!Number.isFinite(n) || Math.abs(n) > 1e12) return { ok: false, error: `"${f.label}" must be a number.` };
        out[f.key] = n;
        break;
      }
      case "user": {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `"${f.label}" must be a person.` };
        out[f.key] = n;
        userIds.push(n);
        break;
      }
      case "choice":
      case "select": {
        const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
        if (!f.options?.some((o) => o.value === s)) return { ok: false, error: `"${f.label}" must be one of its options.` };
        out[f.key] = s;
        break;
      }
      case "checkbox":
        if (v !== true) return { ok: false, error: `"${f.label}" is ticked or not.` };
        out[f.key] = true;
        break;
    }
  }
  if (userIds.length) {
    const found = await hq<{ id: number }>(
      "SELECT id FROM users WHERE id = ANY($1::int[]) AND status = 'active'",
      [[...new Set(userIds)]],
      client
    );
    const ok = new Set(found.map((r) => r.id));
    const bad = form.find((f) => f.type === "user" && typeof out[f.key] === "number" && !ok.has(out[f.key] as number));
    if (bad) return { ok: false, error: `"${bad.label}" must be a person in this workspace.` };
  }
  return { ok: true, value: out };
}

/** An answer as a person reads it: the option's label, "Yes", a date as given, a user's name (from `names`). */
export function answerText(field: HdFormField, value: unknown, names?: Map<number, string>): string {
  if (value === undefined || value === null || value === "") return "";
  if (field.type === "checkbox") return value === true ? "Yes" : "No";
  if (field.type === "choice" || field.type === "select") {
    const o = field.options?.find((x) => x.value === value);
    return o ? (o.hint ? `${o.label} · ${o.hint}` : o.label) : String(value);
  }
  if (field.type === "user") return names?.get(Number(value)) ?? `Person #${value}`;
  return String(value);
}

/** The answers as label/value pairs in form order (what an approver reads). */
export async function answerRows(form: HdFormField[], answers: HdFormAnswers): Promise<{ key: string; label: string; value: string }[]> {
  const ids = form.filter((f) => f.type === "user" && typeof answers[f.key] === "number").map((f) => answers[f.key] as number);
  const names = new Map<number, string>();
  if (ids.length) {
    for (const r of await hq<{ id: number; name: string }>(
      "SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])",
      [ids]
    )) {
      names.set(r.id, r.name);
    }
  }
  return form
    .map((f) => ({ key: f.key, label: f.label, value: answerText(f, answers[f.key], names) }))
    .filter((r) => r.value !== "");
}

// --- Request type input ------------------------------------------------------------

export interface RequestTypeInput {
  slug: string;
  title: string;
  description: string;
  icon: string;
  team_id: number | null;
  category: string;
  form: HdFormField[];
  workflow_id: number | null;
  sla_priority: HdPriority;
  visibility: "all" | "groups";
  group_ids: number[];
  active: number;
  position: number;
  eta_label: string;
}

const optId = (v: unknown): number | null | "bad" => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : "bad";
};

/**
 * Check a create (partial = false) or update (partial = true) body. On an
 * update, fields left out keep their stored value (`base`). References
 * (team, workflow, groups) are checked against the database.
 */
export async function validateRequestTypeInput(
  raw: unknown,
  base?: HdRequestType
): Promise<Checked<RequestTypeInput>> {
  if (!isObj(raw)) return { ok: false, error: "Send the request type as a JSON object." };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const pick = <T>(k: string, fallback: T): unknown => (has(k) ? raw[k] : fallback);

  const title = str(pick("title", base?.title ?? ""));
  if (!title || title.length > REQUEST_TYPE_LIMITS.title) return { ok: false, error: `A request type needs a title (at most ${REQUEST_TYPE_LIMITS.title} characters).` };

  let slug = str(pick("slug", base?.slug ?? ""));
  if (!slug) slug = slugify(title).slice(0, REQUEST_TYPE_LIMITS.slug).replace(/-+$/, "");
  if (!slug || slug.length > REQUEST_TYPE_LIMITS.slug || !SLUG_RE.test(slug)) {
    return { ok: false, error: "The address name is lower-case letters, digits and hyphens." };
  }

  const description = str(pick("description", base?.description ?? ""));
  if (description.length > REQUEST_TYPE_LIMITS.description) return { ok: false, error: `The description is longer than ${REQUEST_TYPE_LIMITS.description} characters.` };
  const icon = str(pick("icon", base?.icon ?? ""));
  if (icon.length > REQUEST_TYPE_LIMITS.icon || !ICON_RE.test(icon)) return { ok: false, error: "The icon is a lucide icon name, like monitor or key." };
  const category = str(pick("category", base?.category ?? ""));
  if (category.length > REQUEST_TYPE_LIMITS.category) return { ok: false, error: `The category is longer than ${REQUEST_TYPE_LIMITS.category} characters.` };
  const eta = str(pick("eta_label", base?.eta_label ?? ""));
  if (eta.length > REQUEST_TYPE_LIMITS.eta) return { ok: false, error: `The time hint is longer than ${REQUEST_TYPE_LIMITS.eta} characters.` };

  const teamId = optId(pick("team_id", base?.team_id ?? null));
  if (teamId === "bad") return { ok: false, error: "Pick a team." };
  const workflowId = optId(pick("workflow_id", base?.workflow_id ?? null));
  if (workflowId === "bad") return { ok: false, error: "Pick a workflow." };

  const priority = pick("sla_priority", base?.sla_priority ?? "normal") as HdPriority;
  if (!HD_PRIORITIES.includes(priority)) return { ok: false, error: "The priority is low, normal, high or urgent." };
  const visibility = pick("visibility", base?.visibility ?? "all");
  if (visibility !== "all" && visibility !== "groups") return { ok: false, error: "Visibility is everyone or chosen groups." };

  const rawGroups = pick("group_ids", base?.group_ids ?? []);
  if (!Array.isArray(rawGroups) || rawGroups.length > REQUEST_TYPE_LIMITS.groups) return { ok: false, error: "Pick the groups from the list." };
  const groupIds = [...new Set(rawGroups.map(Number))];
  if (groupIds.some((g) => !Number.isInteger(g) || g <= 0)) return { ok: false, error: "Pick the groups from the list." };
  if (visibility === "groups" && groupIds.length === 0) return { ok: false, error: "Pick at least one group, or let everyone use it." };

  const rawActive = pick("active", base?.active ?? 1);
  const active = rawActive === true || rawActive === 1 ? 1 : rawActive === false || rawActive === 0 ? 0 : -1;
  if (active < 0) return { ok: false, error: "Active is on or off." };
  const position = Number(pick("position", base?.position ?? 0));
  if (!Number.isInteger(position) || position < 0 || position > 10_000) return { ok: false, error: "The position is a whole number." };

  const form = validateFormFields(pick("form", base?.form ?? []));
  if (!form.ok) return form;

  // References.
  if (teamId !== null && !(await hqOne("SELECT 1 FROM hd_teams WHERE id = $1", [teamId]))) return { ok: false, error: "That team no longer exists." };
  if (workflowId !== null && !(await hqOne("SELECT 1 FROM hd_workflows WHERE id = $1", [workflowId]))) return { ok: false, error: "That workflow no longer exists." };
  if (groupIds.length) {
    const found = await hq<{ id: number }>("SELECT id FROM groups WHERE id = ANY($1::int[])", [groupIds]);
    if (found.length !== groupIds.length) return { ok: false, error: "One of those groups no longer exists." };
  }
  const clash = await hqOne<{ id: number }>("SELECT id FROM hd_request_types WHERE slug = $1 AND id <> $2", [slug, base?.id ?? 0]);
  if (clash) return { ok: false, error: "Another request type already uses that address name." };

  return {
    ok: true,
    value: {
      slug,
      title,
      description,
      icon,
      team_id: teamId,
      category,
      form: form.value,
      workflow_id: workflowId,
      sla_priority: priority,
      visibility,
      group_ids: visibility === "groups" ? groupIds : [],
      active,
      position,
      eta_label: eta,
    },
  };
}

// --- Reads ---------------------------------------------------------------------------

const RT_COLS = `rt.*, tm.name AS team_name,
  coalesce((SELECT array_agg(g.group_id ORDER BY g.group_id) FROM hd_request_type_groups g WHERE g.request_type_id = rt.id), '{}') AS group_ids`;

/** Every request type, for the settings page (inactive ones included). */
export async function listRequestTypes(opts: { activeOnly?: boolean } = {}): Promise<HdRequestType[]> {
  return hq<HdRequestType>(
    `SELECT ${RT_COLS} FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id
      WHERE ($1::boolean IS NOT TRUE OR rt.active = 1)
      ORDER BY rt.position, rt.title, rt.id`,
    [opts.activeOnly ?? false]
  );
}

export async function getRequestType(id: number, client?: HdQueryable): Promise<HdRequestType | undefined> {
  return hqOne<HdRequestType>(
    `SELECT ${RT_COLS} FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id WHERE rt.id = $1`,
    [id],
    client
  );
}

export async function getRequestTypeBySlug(slug: string): Promise<HdRequestType | undefined> {
  return hqOne<HdRequestType>(
    `SELECT ${RT_COLS} FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id WHERE rt.slug = $1`,
    [slug]
  );
}

/**
 * The active request types this person may use: everyone's, plus the
 * restricted ones (visibility 'groups') granted to a group they belong to.
 */
export async function listRequestTypesForUser(user: { id: number }): Promise<HdRequestType[]> {
  return hq<HdRequestType>(
    `SELECT ${RT_COLS} FROM hd_request_types rt LEFT JOIN hd_teams tm ON tm.id = rt.team_id
      WHERE rt.active = 1
        AND (rt.visibility = 'all' OR EXISTS (
              SELECT 1 FROM hd_request_type_groups g JOIN group_members gm ON gm.group_id = g.group_id
               WHERE g.request_type_id = rt.id AND gm.user_id = $1))
      ORDER BY rt.position, rt.title, rt.id`,
    [user.id]
  );
}

/** May this person send a request of this type (active, and theirs to use)? */
export async function mayUseRequestType(user: { id: number }, typeId: number): Promise<boolean> {
  const r = await hqOne(
    `SELECT 1 FROM hd_request_types rt
      WHERE rt.id = $1 AND rt.active = 1
        AND (rt.visibility = 'all' OR EXISTS (
              SELECT 1 FROM hd_request_type_groups g JOIN group_members gm ON gm.group_id = g.group_id
               WHERE g.request_type_id = rt.id AND gm.user_id = $2))`,
    [typeId, user.id]
  );
  return Boolean(r);
}

// --- Writes --------------------------------------------------------------------------

async function writeGroups(client: PoolClient, id: number, groupIds: number[]) {
  await client.query("DELETE FROM hd_request_type_groups WHERE request_type_id = $1", [id]);
  if (groupIds.length) {
    await client.query(
      `INSERT INTO hd_request_type_groups (request_type_id, group_id)
       SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
      [id, groupIds]
    );
  }
}

export async function createRequestType(input: RequestTypeInput): Promise<HdRequestType> {
  const id = await withTx(async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO hd_request_types
         (slug, title, description, icon, team_id, category, form, workflow_id, sla_priority, visibility, active, position, eta_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        input.slug,
        input.title,
        input.description,
        input.icon,
        input.team_id,
        input.category,
        JSON.stringify(input.form),
        input.workflow_id,
        input.sla_priority,
        input.visibility,
        input.active,
        input.position,
        input.eta_label,
      ]
    );
    await writeGroups(client, r.rows[0].id, input.group_ids);
    return r.rows[0].id;
  });
  return (await getRequestType(id))!;
}

export async function updateRequestType(id: number, input: RequestTypeInput): Promise<HdRequestType | undefined> {
  const found = await withTx(async (client) => {
    const r = await client.query(
      `UPDATE hd_request_types SET slug = $2, title = $3, description = $4, icon = $5, team_id = $6, category = $7,
              form = $8::jsonb, workflow_id = $9, sla_priority = $10, visibility = $11, active = $12, position = $13,
              eta_label = $14, updated_at = now()
        WHERE id = $1`,
      [
        id,
        input.slug,
        input.title,
        input.description,
        input.icon,
        input.team_id,
        input.category,
        JSON.stringify(input.form),
        input.workflow_id,
        input.sla_priority,
        input.visibility,
        input.active,
        input.position,
        input.eta_label,
      ]
    );
    if (!r.rowCount) return false;
    await writeGroups(client, id, input.group_ids);
    return true;
  });
  return found ? getRequestType(id) : undefined;
}

/**
 * Delete a request type. Its tickets keep their answers (request_type_id
 * is SET NULL); a type with open requests is better switched off, which is
 * what the settings page offers first, but deleting is allowed.
 */
export async function deleteRequestType(id: number): Promise<HdRequestType | undefined> {
  const existing = await getRequestType(id);
  if (!existing) return undefined;
  await hq("DELETE FROM hd_request_types WHERE id = $1", [id]);
  return existing;
}

/** Open requests of a type (the delete dialog's warning). */
export async function openRequestCount(typeId: number): Promise<number> {
  const r = await hqOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM hd_tickets WHERE request_type_id = $1 AND status IN ('new', 'open', 'pending', 'on_hold')`,
    [typeId]
  );
  return r?.n ?? 0;
}
