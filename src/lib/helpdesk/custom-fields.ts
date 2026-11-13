// Helpdesk 1.20.6: custom fields (schema in lib/helpdesk/custom-fields-schema,
// shapes in custom-fields-shared).
//
//   fields      Desk settings → Custom fields (settings.manage): a label, a
//               stable key, a kind, a help line, options for a choice, the
//               teams it is assigned to (one or more, or every team) and who
//               sees it ("Agent only" or "Public"). The kinds are the request
//               form's (HdFormFieldType), a definition is checked with its
//               validateFormFields and a value with its validateAnswers, so a
//               custom field, a request form question and a "Before you
//               solve" closing field are one set of kinds with one check.
//   on a ticket a ticket shows the fields assigned to its team, in the
//               settings page's order; a ticket with no team shows the "All
//               teams" fields only. An agent who works the ticket fills them
//               in (the same permission as its category and tags):
//               lib/helpdesk/tickets updateTicket takes `custom_fields`
//               ({ "<key>": value | null }) and calls applyCustomFieldsTx in
//               its transaction, so every path that changes a ticket (the
//               desk, the API, the Claude connector, "Before you solve")
//               meets the same check, and each change leaves an internal
//               timeline line.
//   moving      values are never removed by a team move. A field that is not
//               assigned to the ticket's team is not shown and not editable;
//               its value is kept and shown again if the ticket comes back or
//               the field is assigned to the new team too.
//   public      a Public field's value is shown, read-only, to the requester
//               on their request (Get help, the customer portal) once it has
//               a value: publicCustomDetails. It is the only read a requester
//               route makes. Agent-only fields never leave the agent side:
//               no requester page, email, portal route or personal export
//               reads them, and every timeline line of a custom field is
//               internal whatever the field's visibility (a field switched
//               to Agent only later leaves nothing behind in the requester's
//               conversation).
//   archived    kept with its values, no longer shown, edited or required.
//               Restoring it shows the values again.
//   deleted     the field and every value of it are removed (the settings
//               page asks first and says how many tickets hold one).
//   cache       the definitions are read once and kept for 30 seconds
//               (customFieldsSnapshot); with none defined a ticket read costs
//               that one cached lookup and nothing else. A change saved here
//               clears this process's copy at once; another app process
//               follows within 30 seconds. A write (applyCustomFieldsTx)
//               always reads the definitions it needs inside its transaction.
//
// Server-only.

import "server-only";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { HD_FORM_FIELD_TYPES, validateAnswers, validateFormFields } from "./request-types";
import type { HdFormFieldType, HdFormOption } from "./types";
import {
  checkCustomFieldScope,
  customFieldApplies,
  customFieldAsFormField,
  customFieldKeyFrom,
  customValueText,
  isChoiceKind,
  sameValueShape,
  CUSTOM_FIELD_LIMITS,
  type HdCustomField,
  type HdCustomValue,
  type HdPublicDetail,
  type HdSolveCustomField,
  type HdTicketCustomField,
} from "./custom-fields-shared";

export * from "./custom-fields-shared";

export class CustomFieldError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// --- Definitions --------------------------------------------------------------------------

const COLS = "id, key, label, type, help, options, all_teams, team_ids, visibility, position, archived_at, created_at, updated_at";

interface Row {
  id: number;
  key: string;
  label: string;
  type: string;
  help: string;
  options: unknown;
  all_teams: number;
  team_ids: number[] | null;
  visibility: string;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function toField(r: Row): HdCustomField {
  const type = (HD_FORM_FIELD_TYPES as readonly string[]).includes(r.type) ? (r.type as HdFormFieldType) : "text";
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type,
    help: r.help ?? "",
    options: isChoiceKind(type) && Array.isArray(r.options) ? (r.options as HdFormOption[]) : [],
    all_teams: r.all_teams === 1,
    team_ids: r.team_ids ?? [],
    visibility: r.visibility === "public" ? "public" : "agent",
    position: r.position,
    archived: r.archived_at !== null,
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const ORDER = "ORDER BY position, id";

/** Every field, archived ones included, in the settings page's order (read fresh). */
export async function listCustomFields(client?: HdQueryable): Promise<HdCustomField[]> {
  return (await hq<Row>(`SELECT ${COLS} FROM hd_custom_fields ${ORDER}`, [], client)).map(toField);
}

export async function getCustomField(id: number, client?: HdQueryable): Promise<HdCustomField | undefined> {
  const r = await hqOne<Row>(`SELECT ${COLS} FROM hd_custom_fields WHERE id = $1`, [id], client);
  return r ? toField(r) : undefined;
}

const SNAPSHOT_TTL_MS = 30_000;
let cached: { at: number; fields: HdCustomField[] } | null = null;

/** After a field is saved, archived, moved or deleted (and for tests that write the tables themselves). */
export function invalidateCustomFields(): void {
  cached = null;
}

/**
 * Every field, kept for 30 seconds. With none defined this is the whole cost
 * of the feature on a ticket read. Call it outside a transaction (it reads
 * on the pool).
 */
export async function customFieldsSnapshot(): Promise<HdCustomField[]> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.fields;
  const fields = await listCustomFields();
  cached = { at: Date.now(), fields };
  return fields;
}

/** The same for a caller inside a transaction: a fresh copy as it is, otherwise read on the caller's client. */
async function snapshotOn(client?: HdQueryable): Promise<HdCustomField[]> {
  if (!client) return customFieldsSnapshot();
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.fields;
  return listCustomFields(client);
}

/** How many tickets hold a value for each field (the settings list, and the delete question). */
export async function customFieldUse(): Promise<Map<number, number>> {
  const rows = await hq<{ field_id: number; n: number }>("SELECT field_id, count(*)::int AS n FROM hd_ticket_custom_values GROUP BY field_id");
  return new Map(rows.map((r) => [r.field_id, r.n]));
}

interface FieldInput {
  label: string;
  type: HdFormFieldType;
  help: string;
  options: HdFormOption[];
  visibility: HdCustomField["visibility"];
  all_teams: boolean;
  team_ids: number[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Options sent without a value (the API's { label }) take one from their label; a value that is there is kept. */
function withOptionValues(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const taken = new Set<string>(raw.map((o) => (isObj(o) && typeof o.value === "string" ? o.value.trim() : "")).filter(Boolean));
  return raw.map((o) => {
    if (typeof o === "string") o = { label: o };
    if (!isObj(o)) return o;
    if (typeof o.value === "string" && o.value.trim()) return o;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!label) return o;
    const value = customFieldKeyFrom(label, taken);
    taken.add(value);
    return { ...o, value };
  });
}

/** A field's body checked whole: its definition with the request form's check, then who sees it and its teams. */
function checked(raw: unknown): FieldInput {
  const scope = checkCustomFieldScope(raw);
  if (!scope.ok) throw new CustomFieldError(scope.error);
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === "string" ? r.label.trim().replace(/\s+/g, " ") : "";
  if (!label) throw new CustomFieldError("Give the field a label.");
  if (label.length > CUSTOM_FIELD_LIMITS.label) throw new CustomFieldError(`Keep the label under ${CUSTOM_FIELD_LIMITS.label} characters.`);
  const type = r.type === undefined || r.type === null ? "text" : r.type;
  if (typeof type !== "string" || !(HD_FORM_FIELD_TYPES as readonly string[]).includes(type)) {
    throw new CustomFieldError(`The kind is one of: ${HD_FORM_FIELD_TYPES.join(", ")}.`);
  }
  const choice = isChoiceKind(type as HdFormFieldType);
  if (choice && Array.isArray(r.options) && r.options.some((o) => isObj(o) && typeof o.label === "string" && !o.label.trim() && !(typeof o.value === "string" && o.value.trim()))) {
    throw new CustomFieldError("Every option needs a name.");
  }
  // One definition check for every form field in the desk (lib/helpdesk/request-types).
  const f = validateFormFields([{ key: "field", label, type, options: choice ? withOptionValues(r.options) : undefined, help: typeof r.help === "string" ? r.help : undefined }]);
  if (!f.ok) {
    throw new CustomFieldError(
      f.error
        .replace(/^Field "field": /, "")
        .replace(/^Field "field" /, "The field ")
        .replace(/^./, (c) => c.toUpperCase())
    );
  }
  const def = f.value[0];
  return { label, type: def.type, help: def.help ?? "", options: def.options ?? [], ...scope.value };
}

/** The teams the input names exist. */
async function checkTeams(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [ids]);
  if (found.length !== ids.length) throw new CustomFieldError("One of the teams no longer exists. Pick again.");
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Create a field. Its key is made from the label (or taken from `key`, when one is sent and free) and never changes. */
export async function createCustomField(raw: unknown, actor: { id: number | null }): Promise<HdCustomField> {
  const input = checked(raw);
  await checkTeams(input.team_ids);
  const r = raw as Record<string, unknown>;
  const all = await hq<{ key: string }>("SELECT key FROM hd_custom_fields");
  if (all.length >= CUSTOM_FIELD_LIMITS.fields) {
    throw new CustomFieldError(`Up to ${CUSTOM_FIELD_LIMITS.fields} custom fields. Delete one you no longer use.`, 409);
  }
  let key: string;
  if (r.key !== undefined && r.key !== null && r.key !== "") {
    key = typeof r.key === "string" ? r.key.trim() : "";
    if (!key || key.length > CUSTOM_FIELD_LIMITS.key || !KEY_RE.test(key)) {
      throw new CustomFieldError(`A key is lower-case letters, digits and underscores (at most ${CUSTOM_FIELD_LIMITS.key}), starting with a letter.`);
    }
    if (all.some((x) => x.key === key)) throw new CustomFieldError(`Another field already uses the key "${key}".`, 409);
  } else key = customFieldKeyFrom(input.label, all.map((x) => x.key));
  try {
    const row = await hqOne<Row>(
      `INSERT INTO hd_custom_fields (key, label, type, help, options, all_teams, team_ids, visibility, position, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, (SELECT coalesce(max(position), 0) + 1 FROM hd_custom_fields), $9)
       RETURNING ${COLS}`,
      [key, input.label, input.type, input.help, JSON.stringify(input.options), input.all_teams ? 1 : 0, input.team_ids, input.visibility, actor.id]
    );
    invalidateCustomFields();
    return toField(row!);
  } catch (e) {
    // Two admins made the same key at once.
    if ((e as { code?: string }).code === "23505") throw new CustomFieldError(`Another field already uses the key "${key}".`, 409);
    throw e;
  }
}

/** The stored teams that still exist (a team deleted since the last save drops out). */
async function existingTeams(ids: number[]): Promise<number[]> {
  if (!ids.length) return ids;
  const found = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [ids])).map((r) => r.id));
  return ids.filter((id) => found.has(id));
}

/**
 * Update a field; what is left out keeps its stored value. `archived: true`
 * archives it, false restores it. The key never changes. The kind may change
 * only to one whose values read the same (short and long text, the two
 * choices) while tickets hold a value. Tickets keep their values.
 */
export async function updateCustomField(id: number, raw: unknown): Promise<{ before: HdCustomField; after: HdCustomField } | undefined> {
  const before = await getCustomField(id);
  if (!before) return undefined;
  const r = (isObj(raw) ? raw : {}) as Record<string, unknown>;
  if (r.key !== undefined && r.key !== null && r.key !== before.key) throw new CustomFieldError("A field's key can't be changed. Integrations and reports rely on it.");
  if (r.archived !== undefined && typeof r.archived !== "boolean") throw new CustomFieldError("archived is true or false.");
  const teamsSent = r.team_ids !== undefined || r.all_teams !== undefined;
  const input = checked({
    label: r.label ?? before.label,
    type: r.type ?? before.type,
    help: r.help ?? before.help,
    options: r.options ?? before.options,
    visibility: r.visibility ?? before.visibility,
    ...(teamsSent ? { all_teams: r.all_teams, team_ids: r.team_ids } : { all_teams: true }),
  });
  if (!teamsSent) {
    // Left as they were, less any team deleted since (a field whose teams are all gone is shown nowhere until it is given one).
    input.all_teams = before.all_teams;
    input.team_ids = before.all_teams ? [] : await existingTeams(before.team_ids);
  }
  await checkTeams(input.team_ids);
  if (!sameValueShape(before.type, input.type)) {
    const n = (await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_ticket_custom_values WHERE field_id = $1", [id]))?.n ?? 0;
    if (n > 0) {
      throw new CustomFieldError(
        `${n === 1 ? "1 ticket holds" : `${n} tickets hold`} a value for this field, so its kind can't change. Archive it and add a new field instead.`,
        409
      );
    }
  }
  const archived = r.archived === undefined ? before.archived : r.archived;
  const row = await hqOne<Row>(
    `UPDATE hd_custom_fields
        SET label = $2, type = $3, help = $4, options = $5::jsonb, all_teams = $6, team_ids = $7, visibility = $8,
            archived_at = CASE WHEN $9::boolean THEN coalesce(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, input.label, input.type, input.help, JSON.stringify(input.options), input.all_teams ? 1 : 0, input.team_ids, input.visibility, archived]
  );
  invalidateCustomFields();
  return row ? { before, after: toField(row) } : undefined;
}

/** Delete a field and every ticket's value for it. Answers the field and how many tickets held a value. */
export async function deleteCustomField(id: number): Promise<{ field: HdCustomField; tickets: number } | undefined> {
  const out = await withTx(async (client) => {
    const n = (await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_ticket_custom_values WHERE field_id = $1", [id], client))?.n ?? 0;
    const r = await hqOne<Row>(`DELETE FROM hd_custom_fields WHERE id = $1 RETURNING ${COLS}`, [id], client);
    if (!r) return undefined;
    // A "Before you solve" set that required it no longer does.
    await client.query("UPDATE hd_solve_requirement_sets SET custom_field_ids = array_remove(custom_field_ids, $1), updated_at = now() WHERE $1 = ANY(custom_field_ids)", [id]);
    return { field: toField(r), tickets: n };
  });
  invalidateCustomFields();
  if (out) (await import("./solve-requirements")).invalidateSolveSets();
  return out;
}

/** Put the listed fields first, in that order; fields left out keep their order after them. */
export async function reorderCustomFields(raw: unknown): Promise<HdCustomField[]> {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number" || !Number.isInteger(v) || v <= 0)) throw new CustomFieldError("Send the order as { ids: [field ids] }.");
  const ids = [...new Set(raw as number[])];
  const out = await withTx(async (client) => {
    const all = await listCustomFields(client);
    if (ids.some((id) => !all.some((f) => f.id === id))) throw new CustomFieldError("One of the fields no longer exists. Reload and try again.", 409);
    const order = [...ids, ...all.filter((f) => !ids.includes(f.id)).map((f) => f.id)];
    await client.query(
      `UPDATE hd_custom_fields f SET position = o.pos
         FROM (SELECT id, pos::int FROM unnest($1::int[]) WITH ORDINALITY AS u(id, pos)) o
        WHERE f.id = o.id AND f.position <> o.pos`,
      [order]
    );
    return listCustomFields(client);
  });
  invalidateCustomFields();
  return out;
}

// --- A ticket's values ----------------------------------------------------------------------

interface ValueRow {
  field_id: number;
  value: HdCustomValue;
  display: string;
}

type TicketRef = { id: number; team_id: number | null };

async function valuesOf(ticketId: number, fieldIds: number[], client?: HdQueryable): Promise<Map<number, ValueRow>> {
  if (!fieldIds.length) return new Map();
  const rows = await hq<ValueRow>("SELECT field_id, value, display FROM hd_ticket_custom_values WHERE ticket_id = $1 AND field_id = ANY($2::int[])", [ticketId, fieldIds], client);
  return new Map(rows.map((r) => [r.field_id, r]));
}

/** People's names for "A person" values, in one read. */
async function namesFor(fields: HdCustomField[], values: Map<number, ValueRow>, client?: HdQueryable): Promise<Map<number, string>> {
  const ids = [...new Set(fields.filter((f) => f.type === "user").map((f) => values.get(f.id)?.value).filter((v): v is number => typeof v === "number"))];
  const names = new Map<number, string>();
  if (!ids.length) return names;
  for (const r of await hq<{ id: number; name: string }>("SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [ids], client)) names.set(r.id, r.name);
  return names;
}

/**
 * The fields shown on a ticket (the ones assigned to its team, in order)
 * with their values: the agent's view. [] when no field applies; with no
 * field defined at all, nothing is read beyond the cached definitions.
 */
export async function ticketCustomFields(t: TicketRef, client?: HdQueryable): Promise<HdTicketCustomField[]> {
  const fields = (await snapshotOn(client)).filter((f) => customFieldApplies(f, t.team_id));
  if (!fields.length) return [];
  const values = await valuesOf(t.id, fields.map((f) => f.id), client);
  const names = await namesFor(fields, values, client);
  return fields.map((f) => {
    const v = values.get(f.id);
    return {
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      help: f.help,
      options: f.options,
      visibility: f.visibility,
      value: v ? v.value : null,
      text: v ? customValueText(f, v.value, { names, kept: v.display }) : "",
    };
  });
}

/**
 * What a requester reads: the Public fields of the ticket's team that have
 * a value, in order. The one read every requester-side surface makes (Get
 * help, the customer portal, the personal data export, the requester's
 * Claude tools); an agent-only field is filtered out here, before any value
 * is read. `people: false` leaves "A person" fields out (the customer
 * portal never names staff by their full name).
 */
export async function publicCustomDetails(t: TicketRef, opts: { people?: boolean; client?: HdQueryable } = {}): Promise<HdPublicDetail[]> {
  const fields = (await snapshotOn(opts.client)).filter((f) => f.visibility === "public" && customFieldApplies(f, t.team_id) && (opts.people !== false || f.type !== "user"));
  if (!fields.length) return [];
  const values = await valuesOf(t.id, fields.map((f) => f.id), opts.client);
  if (!values.size) return [];
  const names = await namesFor(fields, values, opts.client);
  const out: HdPublicDetail[] = [];
  for (const f of fields) {
    const v = values.get(f.id);
    if (!v) continue;
    const text = customValueText(f, v.value, { names, kept: v.display });
    if (text) out.push({ key: f.key, label: f.label, type: f.type, value: text });
  }
  return out;
}

/** The same for many tickets at once (the personal data export): ticket id → details. */
export async function publicCustomDetailsFor(tickets: TicketRef[]): Promise<Map<number, HdPublicDetail[]>> {
  const out = new Map<number, HdPublicDetail[]>();
  if (!tickets.length) return out;
  if (!(await customFieldsSnapshot()).some((f) => f.visibility === "public" && !f.archived)) return out;
  for (const t of tickets) {
    const d = await publicCustomDetails(t);
    if (d.length) out.set(t.id, d);
  }
  return out;
}

/** The values as integrations read them (the API, webhooks): { "<key>": value | null } for the fields of the ticket's team; {} when none applies. */
export async function customFieldsOut(t: TicketRef): Promise<Record<string, HdCustomValue>> {
  const out: Record<string, HdCustomValue> = {};
  for (const f of await ticketCustomFields(t)) out[f.key] = f.value;
  return out;
}

/** The definitions as integrations read them (GET /api/helpdesk/v1/custom-fields, hd_read_ticket). */
export function customFieldOut(f: HdCustomField | HdTicketCustomField) {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.help ? { help: f.help } : {}),
    ...(isChoiceKind(f.type) ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    visibility: f.visibility,
  };
}

/** hd_read_ticket (agents): each field of the ticket's team with its value, and how to set it with hd_update_ticket. */
export async function customFieldsForMcp(t: TicketRef) {
  return (await ticketCustomFields(t)).map((f) => ({ ...customFieldOut(f), value: f.value, text: f.text }));
}

/** The side panel's rows on the printed ticket (agents): label and value, filled ones only. */
export async function customFieldPrintRows(t: TicketRef): Promise<[string, string][]> {
  return (await ticketCustomFields(t)).filter((f) => f.text).map((f) => [f.label, f.text]);
}

// --- Writing ---------------------------------------------------------------------------------

interface ValueWrite {
  field: HdCustomField;
  /** null: clear it. */
  value: HdCustomValue;
}

const BAD_SHAPE = 'Send custom_fields as an object keyed by field key, like { "impact": "high" }. null clears a value.';

/**
 * Check values sent for a ticket of `teamId` against the definitions (read
 * on `client`): each key names a field that is not archived and is assigned
 * to the ticket's team, and each value is valid for its kind (the request
 * form's answer check). null or "" clears. Answers the writes, or the
 * sentence a route says with 400.
 */
export async function checkCustomValues(raw: unknown, teamId: number | null, client?: HdQueryable): Promise<{ ok: true; writes: ValueWrite[] } | { ok: false; error: string }> {
  if (!isObj(raw)) return { ok: false, error: BAD_SHAPE };
  const keys = Object.keys(raw);
  if (!keys.length) return { ok: true, writes: [] };
  if (keys.length > CUSTOM_FIELD_LIMITS.fields) return { ok: false, error: BAD_SHAPE };
  const defs = (await hq<Row>(`SELECT ${COLS} FROM hd_custom_fields WHERE key = ANY($1::text[])`, [keys], client)).map(toField);
  const writes: ValueWrite[] = [];
  for (const key of keys) {
    const field = defs.find((d) => d.key === key);
    if (!field) return { ok: false, error: `There is no custom field with the key "${key.slice(0, 60)}".` };
    if (field.archived) return { ok: false, error: `"${field.label}" is archived, so it can't be changed.` };
    if (!customFieldApplies(field, teamId)) {
      return { ok: false, error: teamId === null ? `"${field.label}" isn't a field of tickets with no team.` : `"${field.label}" isn't a field of this ticket's team.` };
    }
    const sent = raw[key];
    if (sent === null || sent === undefined || (typeof sent === "string" && sent.trim() === "")) {
      writes.push({ field, value: null });
      continue;
    }
    const c = await validateAnswers([customFieldAsFormField(field)], { [key]: sent }, client);
    if (!c.ok) return { ok: false, error: c.error };
    writes.push({ field, value: Object.prototype.hasOwnProperty.call(c.value, key) ? c.value[key] : null });
  }
  return { ok: true, writes };
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/**
 * lib/helpdesk/tickets updateTicket, inside its transaction (the ticket's
 * row is locked): store the values sent as `custom_fields`. Throws
 * CustomFieldError (400) on a key or value that is not valid for this
 * ticket; nothing is stored then. Answers the keys that changed and one
 * internal timeline line per change.
 */
export async function applyCustomFieldsTx(
  client: HdQueryable,
  opts: { ticketId: number; teamId: number | null; values: unknown; actor: { id: number | null; name: string }; now: Date }
): Promise<{ changed: string[]; lines: string[] }> {
  const c = await checkCustomValues(opts.values, opts.teamId, client);
  if (!c.ok) throw new CustomFieldError(c.error);
  if (!c.writes.length) return { changed: [], lines: [] };
  const before = await valuesOf(opts.ticketId, c.writes.map((w) => w.field.id), client);
  const names = new Map<number, string>();
  const people = [...new Set(c.writes.filter((w) => w.field.type === "user" && typeof w.value === "number").map((w) => w.value as number))];
  if (people.length) {
    for (const r of await hq<{ id: number; name: string }>("SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [people], client)) names.set(r.id, r.name);
  }
  const who = mdInline(opts.actor.name) || "Someone";
  const changed: string[] = [];
  const lines: string[] = [];
  for (const w of c.writes) {
    const old = before.get(w.field.id);
    if (w.value === null) {
      if (!old) continue;
      await client.query("DELETE FROM hd_ticket_custom_values WHERE ticket_id = $1 AND field_id = $2", [opts.ticketId, w.field.id]);
      changed.push(w.field.key);
      lines.push(`${who} cleared ${mdInline(w.field.label)}`);
      continue;
    }
    if (old && JSON.stringify(old.value) === JSON.stringify(w.value)) continue;
    const text = customValueText(w.field, w.value, { names });
    await client.query(
      `INSERT INTO hd_ticket_custom_values (ticket_id, field_id, value, display, updated_by, updated_by_name, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (ticket_id, field_id) DO UPDATE
         SET value = EXCLUDED.value, display = EXCLUDED.display, updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`,
      [opts.ticketId, w.field.id, JSON.stringify(w.value), text, opts.actor.id, opts.actor.name, opts.now]
    );
    changed.push(w.field.key);
    lines.push(`${who} set ${mdInline(w.field.label)} to ${mdInline(short(text))}`);
  }
  return { changed, lines };
}

// --- "Before you solve" ------------------------------------------------------------------------

/**
 * lib/helpdesk/solve-requirements evaluateSolve: of the custom fields a set
 * requires, the ones that apply to this ticket (assigned to its team, not
 * archived, still there), each filled in or not. `pending` is the
 * `custom_fields` a solve is about to send (the dialog's check before it
 * submits): checked as a write would be, and counted as filled.
 */
export async function customFieldsForSolve(
  ticketId: number,
  teamId: number | null,
  fieldIds: number[],
  opts: { client?: HdQueryable; pending?: unknown } = {}
): Promise<{ invalid: string | null; fields: HdSolveCustomField[] }> {
  let pending: ValueWrite[] = [];
  if (opts.pending !== undefined && opts.pending !== null) {
    const c = await checkCustomValues(opts.pending, teamId, opts.client);
    if (!c.ok) return { invalid: c.error, fields: [] };
    pending = c.writes;
  }
  const all = await snapshotOn(opts.client);
  const fields = fieldIds.map((id) => all.find((f) => f.id === id)).filter((f): f is HdCustomField => !!f && customFieldApplies(f, teamId));
  if (!fields.length) return { invalid: null, fields: [] };
  const values = await valuesOf(ticketId, fields.map((f) => f.id), opts.client);
  return {
    invalid: null,
    fields: fields.map((f) => {
      const p = pending.find((w) => w.field.id === f.id);
      const met = p ? p.value !== null : values.has(f.id);
      return { id: f.id, key: f.key, label: f.label, type: f.type, help: f.help, options: f.options, met };
    }),
  };
}

// --- Retention --------------------------------------------------------------------------------

/**
 * lib/helpdesk/retention anonymiseTicketTx: free text and people go, as the
 * request form's and the "Before you solve" answers do. Choices, numbers,
 * dates and ticks stay for reporting (they name nobody).
 */
export async function anonymiseCustomValuesTx(client: HdQueryable, ticketId: number): Promise<void> {
  await client.query(
    `DELETE FROM hd_ticket_custom_values v USING hd_custom_fields f
      WHERE v.field_id = f.id AND v.ticket_id = $1 AND f.type IN ('text', 'textarea', 'user')`,
    [ticketId]
  );
}
