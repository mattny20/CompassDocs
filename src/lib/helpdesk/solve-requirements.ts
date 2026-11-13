// Helpdesk 1.20.5: "Before you solve" requirements (schema in
// lib/helpdesk/solve-requirements-schema, shapes in solve-requirements-shared).
//
//   sets        Desk settings → Before you solve (settings.manage): each set
//               has a name, an on/off switch, a scope (every ticket, or
//               chosen teams and request types; with both chosen a ticket
//               must match both) and requirements of two kinds: ticket fields
//               that must be set (an owner, a team, a category, a tag, a
//               linked asset, time logged, a reply sent) and closing fields
//               the agent fills in, defined with the request form's field
//               types and checked with its validators (lib/helpdesk/
//               request-types validateFormFields, validateAnswers). Every
//               switched-on set that matches a ticket applies.
//   solving     lib/helpdesk/tickets updateTicket asks applySolveRequirementsTx
//               inside its transaction, right after the checklist check, so
//               every solver meets the same rule: the desk's Solve and `e`,
//               Send and set Solved, macros, bulk edit, automations, alert
//               intake, major incidents, the API and the Claude connector.
//               Something missing: HdTicketError 409 with one sentence
//               (SOLVE_BLOCK_PREFIX), `code: "solve_requirements"` and the
//               list of what is missing. Nothing missing: the answers sent
//               with the solve (`solve_answers`) are stored in that same
//               transaction, so they are saved only if the ticket is solved.
//               A solver that cannot ask a person is treated as checklists
//               treat it: a person's macro and a bulk edit are refused for
//               that ticket, an automation drops only the status change, a
//               workflow's Finish step leaves the request open with a note.
//   answers     `solve_answers` is an object keyed by closing field key. A
//               bare key answers every matching set that has that key;
//               "<set id>:<key>" answers one set (the desk sends these).
//               Unknown keys are ignored. An answer left out keeps the one
//               the ticket already has, so a reopened ticket is asked only
//               for what is still missing.
//   kept        the answers stay on the ticket (hd_ticket_solve_answers) with
//               the words they were asked in. Reopening keeps them; a set
//               edited, switched off or deleted later never rewrites them; a
//               stored answer that no longer fits its field (an option that
//               was removed) is asked again. They are agents-only: no
//               requester route returns them, and their timeline line is
//               internal.
//   not asked   solved → closed (retention's auto-close; it was already
//               solved), a merge (the merged ticket is closed, not solved),
//               the recycle bin, workflow task tickets (their hand-off is
//               their closing step), tickets solved before a set existed
//               (until they are reopened and solved again), and a newbie's
//               reply held for review (it changes no status).
//   "a reply"   the ticket's first-reply stamp (first_replied_at): a public
//               message by the desk that was sent. A reply held for review
//               counts once a lead approves it. "Send and set Solved" counts
//               the reply it is about to send.
//   cache       the switched-on sets are read once and kept for 30 seconds
//               (solveSetsSnapshot); with none defined a solve costs that one
//               cached lookup and nothing else. A change saved here clears
//               this process's copy at once; another app process follows
//               within 30 seconds.
//
// Server-only.

import "server-only";
import { hq, hqOne, type HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { answerText, validateAnswers, validateFormFields } from "./request-types";
import type { HdFormAnswers, HdFormField, HdStatus } from "./types";
import {
  checkSolveSetInput,
  isSolveTicketField,
  solveAnswerKey,
  solveBlockMessage,
  solveSetMatches,
  solvesForRequirements,
  SOLVE_BLOCK_CODE,
  SOLVE_REQ_LIMITS,
  SOLVE_TICKET_FIELD_LABEL,
  SOLVE_TICKET_FIELDS,
  type HdSolveCheck,
  type HdSolveDetail,
  type HdSolveMissing,
  type HdSolveRequirementSet,
  type HdSolveRequirementSetInput,
  type HdSolveTicketField,
} from "./solve-requirements-shared";

export * from "./solve-requirements-shared";

export class SolveRequirementError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// --- Sets -------------------------------------------------------------------------------

const SET_COLS = "id, name, enabled, team_ids, request_type_ids, ticket_fields, fields, created_at, updated_at";

type SetRow = Omit<HdSolveRequirementSet, "enabled" | "ticket_fields"> & { enabled: number; ticket_fields: string[] };

function toSet(r: SetRow): HdSolveRequirementSet {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    team_ids: r.team_ids ?? [],
    request_type_ids: r.request_type_ids ?? [],
    ticket_fields: (r.ticket_fields ?? []).filter(isSolveTicketField),
    fields: Array.isArray(r.fields) ? r.fields : [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Every set, for the settings page (switched-off ones included). */
export async function listSolveSets(): Promise<HdSolveRequirementSet[]> {
  return (await hq<SetRow>(`SELECT ${SET_COLS} FROM hd_solve_requirement_sets ORDER BY lower(name), id`)).map(toSet);
}

export async function getSolveSet(id: number): Promise<HdSolveRequirementSet | undefined> {
  const r = await hqOne<SetRow>(`SELECT ${SET_COLS} FROM hd_solve_requirement_sets WHERE id = $1`, [id]);
  return r ? toSet(r) : undefined;
}

/** A set's body checked whole: its own fields, then the closing fields with the request form's check. */
function checked(raw: unknown): HdSolveRequirementSetInput {
  const c = checkSolveSetInput(raw);
  if (!c.ok) throw new SolveRequirementError(c.error);
  const f = validateFormFields((raw as Record<string, unknown>).fields);
  if (!f.ok) throw new SolveRequirementError(f.error.replace(/^The form must be/, "The closing fields must be").replace(/^A form has/, "A requirement set has"));
  if (f.value.length > SOLVE_REQ_LIMITS.fields) throw new SolveRequirementError(`A requirement set has up to ${SOLVE_REQ_LIMITS.fields} closing fields.`);
  // A closing field is filled in by an agent: there is no directory entry to prefill it from.
  const fields = f.value.map(({ default_from: _drop, ...rest }) => rest);
  if (c.value.enabled && !c.value.ticket_fields.length && !fields.length) {
    throw new SolveRequirementError("Add at least one requirement before you switch the set on.");
  }
  return { ...c.value, fields };
}

/** Teams and request types the input names exist. */
async function checkRefs(input: HdSolveRequirementSetInput): Promise<void> {
  if (input.team_ids.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1::int[])", [input.team_ids]);
    if (found.length !== input.team_ids.length) throw new SolveRequirementError("One of the teams no longer exists. Pick again.");
  }
  if (input.request_type_ids.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_request_types WHERE id = ANY($1::int[])", [input.request_type_ids]);
    if (found.length !== input.request_type_ids.length) throw new SolveRequirementError("One of the request types no longer exists. Pick again.");
  }
}

export async function createSolveSet(raw: unknown, actor: { id: number | null }): Promise<HdSolveRequirementSet> {
  const input = checked(raw);
  await checkRefs(input);
  const n = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_solve_requirement_sets");
  if ((n?.n ?? 0) >= SOLVE_REQ_LIMITS.sets) throw new SolveRequirementError(`Up to ${SOLVE_REQ_LIMITS.sets} requirement sets. Delete one you no longer use.`, 409);
  const r = await hqOne<SetRow>(
    `INSERT INTO hd_solve_requirement_sets (name, enabled, team_ids, request_type_ids, ticket_fields, fields, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING ${SET_COLS}`,
    [input.name, input.enabled ? 1 : 0, input.team_ids, input.request_type_ids, input.ticket_fields, JSON.stringify(input.fields), actor.id]
  );
  invalidateSolveSets();
  return toSet(r!);
}

/** Update a set; what is left out keeps its stored value. Tickets keep the answers they have. */
export async function updateSolveSet(id: number, raw: unknown): Promise<{ before: HdSolveRequirementSet; after: HdSolveRequirementSet } | undefined> {
  const before = await getSolveSet(id);
  if (!before) return undefined;
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const input = checked({
    name: r.name ?? before.name,
    enabled: r.enabled ?? before.enabled,
    // A team or request type deleted since the last save drops out of the stored scope here.
    team_ids: r.team_ids ?? (await existing("hd_teams", before.team_ids)),
    request_type_ids: r.request_type_ids ?? (await existing("hd_request_types", before.request_type_ids)),
    ticket_fields: r.ticket_fields ?? before.ticket_fields,
    fields: r.fields ?? before.fields,
  });
  await checkRefs(input);
  const row = await hqOne<SetRow>(
    `UPDATE hd_solve_requirement_sets SET name = $2, enabled = $3, team_ids = $4, request_type_ids = $5, ticket_fields = $6, fields = $7::jsonb, updated_at = now()
      WHERE id = $1 RETURNING ${SET_COLS}`,
    [id, input.name, input.enabled ? 1 : 0, input.team_ids, input.request_type_ids, input.ticket_fields, JSON.stringify(input.fields)]
  );
  invalidateSolveSets();
  return row ? { before, after: toSet(row) } : undefined;
}

async function existing(table: "hd_teams" | "hd_request_types", ids: number[]): Promise<number[]> {
  if (!ids.length) return ids;
  const found = new Set((await hq<{ id: number }>(`SELECT id FROM ${table} WHERE id = ANY($1::int[])`, [ids])).map((r) => r.id));
  return ids.filter((id) => found.has(id));
}

/** Delete a set. Tickets keep the answers they gave to it. */
export async function deleteSolveSet(id: number): Promise<HdSolveRequirementSet | undefined> {
  const r = await hqOne<SetRow>(`DELETE FROM hd_solve_requirement_sets WHERE id = $1 RETURNING ${SET_COLS}`, [id]);
  invalidateSolveSets();
  return r ? toSet(r) : undefined;
}

/** How many tickets hold an answer to each set (the settings list's "Answered on"). */
export async function solveSetUse(): Promise<Map<number, number>> {
  const rows = await hq<{ set_id: number; n: number }>("SELECT set_id, count(DISTINCT ticket_id)::int AS n FROM hd_ticket_solve_answers GROUP BY set_id");
  return new Map(rows.map((r) => [r.set_id, r.n]));
}

/** The ticket fields a set may require on this install: an asset only while an asset source is connected. */
export async function availableTicketFields(): Promise<HdSolveTicketField[]> {
  const assets = await assetsOn();
  return SOLVE_TICKET_FIELDS.filter((f) => f !== "asset" || assets);
}

async function assetsOn(): Promise<boolean> {
  try {
    return await (await import("./assets")).assetsConnected();
  } catch {
    return false;
  }
}

// --- The switched-on sets, cached ---------------------------------------------------------

export interface SolveSetsSnapshot {
  /** The switched-on sets that require something. */
  sets: HdSolveRequirementSet[];
  /** An asset source is connected (read only when a set requires an asset). Off: that requirement is skipped, since nothing could be linked. */
  assetsOn: boolean;
}

const SNAPSHOT_TTL_MS = 30_000;
let cached: { at: number; snap: SolveSetsSnapshot } | null = null;
/** The last known answer to "is an asset source connected?", kept past the TTL for a read inside a transaction. */
let lastAssetsOn: boolean | null = null;

/** After a set is saved or deleted (and for tests that write the tables themselves). */
export function invalidateSolveSets(): void {
  cached = null;
}

const NO_SETS: SolveSetsSnapshot = { sets: [], assetsOn: false };

async function loadSets(client?: HdQueryable): Promise<HdSolveRequirementSet[]> {
  const rows = await hq<SetRow>(`SELECT ${SET_COLS} FROM hd_solve_requirement_sets WHERE enabled = 1 ORDER BY lower(name), id`, [], client);
  return rows.map(toSet).filter((s) => s.ticket_fields.length || s.fields.length);
}

/**
 * The switched-on sets, kept for 30 seconds. Call it outside a transaction
 * (it reads on the pool). With no sets this is the whole cost of the
 * feature on a solve.
 */
export async function solveSetsSnapshot(): Promise<SolveSetsSnapshot> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snap;
  const sets = await loadSets();
  const snap: SolveSetsSnapshot = sets.length ? { sets, assetsOn: sets.some((s) => s.ticket_fields.includes("asset")) ? await assetsOn() : false } : NO_SETS;
  if (sets.length) lastAssetsOn = snap.assetsOn;
  cached = { at: Date.now(), snap };
  return snap;
}

/**
 * The same for a caller already inside a transaction (the workflow engine's
 * Finish step): a fresh copy is used as it is; otherwise the sets are read
 * on the caller's client, never on a second pooled connection, and "is an
 * asset source connected?" is the last known answer (not known yet: the
 * asset requirement is skipped this once, and the copy is refreshed in the
 * background for the next caller).
 */
export async function solveSetsSnapshotTx(client: HdQueryable): Promise<SolveSetsSnapshot> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snap;
  const sets = await loadSets(client);
  if (!sets.length) return NO_SETS;
  void solveSetsSnapshot().catch(() => {});
  return { sets, assetsOn: lastAssetsOn ?? false };
}

// --- The check ----------------------------------------------------------------------------

/** What the check reads off the ticket (as it will be once the solve's own field changes are applied). */
export interface SolveTicketFacts {
  id: number;
  team_id: number | null;
  request_type_id: number | null;
  assignee_id: number | null;
  category: string;
  tags: string[];
  first_replied_at: string | null;
  source: string;
}

interface StoredAnswer {
  set_id: number;
  field_key: string;
  set_name: string;
  label: string;
  type: HdFormField["type"];
  value: HdFormAnswers[string];
  display: string;
  position: number;
  answered_by_name: string;
  answered_at: string;
}

interface AnswerWrite {
  set_id: number;
  set_name: string;
  field: HdFormField;
  position: number;
  value: HdFormAnswers[string];
}

export interface SolveEvaluation {
  applies: boolean;
  /** The matching sets, each ticket field marked met or not. */
  sets: HdSolveCheck["sets"];
  missing: HdSolveMissing[];
  optionalOpen: number;
  /** A sent answer that isn't valid for its field: the sentence (400). */
  invalid: string | null;
  /** Answers to store with the solve, and stored ones a sent empty answer clears. */
  upserts: AnswerWrite[];
  clears: { set_id: number; key: string }[];
  /** The answers the ticket has now (still valid for their fields), keyed "<set id>:<key>". */
  answers: HdFormAnswers;
}

const NOT_APPLICABLE: SolveEvaluation = { applies: false, sets: [], missing: [], optionalOpen: 0, invalid: null, upserts: [], clears: [], answers: {} };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function storedAnswers(ticketId: number, client?: HdQueryable): Promise<StoredAnswer[]> {
  return hq<StoredAnswer>(
    `SELECT set_id, field_key, set_name, label, type, value, display, position, answered_by_name, answered_at
       FROM hd_ticket_solve_answers WHERE ticket_id = $1 ORDER BY set_id, position, field_key`,
    [ticketId],
    client
  );
}

/**
 * What a solve of this ticket needs, given the answers sent with it. Reads
 * on `client` when one is given (inside updateTicket's transaction); writes
 * nothing.
 */
export async function evaluateSolve(
  snap: SolveSetsSnapshot,
  t: SolveTicketFacts,
  opts: { client?: HdQueryable; answers?: unknown; replyPending?: boolean } = {}
): Promise<SolveEvaluation> {
  if (!snap.sets.length) return NOT_APPLICABLE;
  // A workflow task's closing step is its hand-off (engine validateTaskSolve).
  if (t.source === "workflow") return NOT_APPLICABLE;
  const matched = snap.sets.filter((s) => solveSetMatches(s, t));
  if (!matched.length) return NOT_APPLICABLE;
  if (opts.answers !== undefined && opts.answers !== null && !isObj(opts.answers)) {
    return { ...NOT_APPLICABLE, applies: true, invalid: 'Send solve_answers as an object keyed by closing field key, like { "resolution_code": "fixed" }.' };
  }
  const given = isObj(opts.answers) ? opts.answers : {};
  const client = opts.client;

  // Ticket fields: each fact is read only when a matching set asks for it.
  const wanted = new Set<HdSolveTicketField>(matched.flatMap((s) => s.ticket_fields));
  if (wanted.has("asset") && !snap.assetsOn) wanted.delete("asset");
  const met = new Map<HdSolveTicketField, boolean>();
  if (wanted.has("assignee")) met.set("assignee", t.assignee_id !== null);
  if (wanted.has("team")) met.set("team", t.team_id !== null);
  if (wanted.has("category")) met.set("category", (t.category ?? "").trim() !== "");
  if (wanted.has("tag")) met.set("tag", (t.tags ?? []).length > 0);
  if (wanted.has("reply")) met.set("reply", t.first_replied_at !== null || opts.replyPending === true);
  if (wanted.has("asset")) met.set("asset", !!(await hqOne("SELECT 1 AS x FROM hd_ticket_assets WHERE ticket_id = $1 LIMIT 1", [t.id], client)));
  if (wanted.has("time")) met.set("time", !!(await hqOne("SELECT 1 AS x FROM hd_time_entries WHERE ticket_id = $1 AND minutes > 0 LIMIT 1", [t.id], client)));

  const missing: HdSolveMissing[] = [];
  for (const f of SOLVE_TICKET_FIELDS) {
    if (met.get(f) === false) missing.push({ kind: "ticket_field", field: f, label: SOLVE_TICKET_FIELD_LABEL[f] });
  }

  // Closing fields: an answer sent now, else the one the ticket has, if it still fits the field.
  const stored = matched.some((s) => s.fields.length) ? await storedAnswers(t.id, client) : [];
  const storedBy = new Map(stored.map((a) => [solveAnswerKey(a.set_id, a.field_key), a]));
  const upserts: AnswerWrite[] = [];
  const clears: { set_id: number; key: string }[] = [];
  const answers: HdFormAnswers = {};
  let optionalOpen = 0;
  for (const s of matched) {
    for (const [position, f] of s.fields.entries()) {
      const qk = solveAnswerKey(s.id, f.key);
      const has = Object.prototype.hasOwnProperty.call(given, qk) || Object.prototype.hasOwnProperty.call(given, f.key);
      const loose: HdFormField = { ...f, required: false };
      let value: HdFormAnswers[string] | undefined;
      if (has) {
        const sent = Object.prototype.hasOwnProperty.call(given, qk) ? given[qk] : given[f.key];
        const c = await validateAnswers([loose], { [f.key]: sent }, client);
        if (!c.ok) return { ...NOT_APPLICABLE, applies: true, invalid: c.error };
        if (Object.prototype.hasOwnProperty.call(c.value, f.key)) {
          value = c.value[f.key];
          upserts.push({ set_id: s.id, set_name: s.name, field: f, position, value });
        } else if (storedBy.has(qk)) clears.push({ set_id: s.id, key: f.key });
      } else {
        const old = storedBy.get(qk);
        if (old) {
          const c = await validateAnswers([loose], { [f.key]: old.value }, client);
          if (c.ok && Object.prototype.hasOwnProperty.call(c.value, f.key)) value = c.value[f.key];
        }
      }
      // A required tick box must be ticked, as on a request form.
      const answered = value !== undefined && !(f.required && f.type === "checkbox" && value !== true);
      if (answered) answers[qk] = value as HdFormAnswers[string];
      else if (f.required) missing.push({ kind: "closing_field", set_id: s.id, set_name: s.name, key: f.key, label: f.label });
      else optionalOpen++;
    }
  }
  return {
    applies: true,
    sets: matched.map((s) => ({
      id: s.id,
      name: s.name,
      ticket_fields: s.ticket_fields.filter((f) => wanted.has(f)).map((f) => ({ field: f, label: SOLVE_TICKET_FIELD_LABEL[f], met: met.get(f) === true })),
      fields: s.fields,
    })),
    missing,
    optionalOpen,
    invalid: null,
    upserts,
    clears,
    answers,
  };
}

/** An answer as the ticket shows it: an option by its label alone (its hint helps to choose, not to read back), the rest as a request form's answers read. */
function displayOf(f: HdFormField, value: HdFormAnswers[string], names: Map<number, string>): string {
  if (f.type === "choice" || f.type === "select") return f.options?.find((o) => o.value === value)?.label ?? String(value ?? "");
  return answerText(f, value, names);
}

/** The refusal a route answers with: the sentence, the code, and what is missing. */
export interface SolveRefusal {
  status: 400 | 409;
  error: string;
  code: typeof SOLVE_BLOCK_CODE;
  missing: HdSolveMissing[];
}

function refusalOf(e: SolveEvaluation): SolveRefusal | null {
  if (e.invalid) return { status: 400, error: e.invalid, code: SOLVE_BLOCK_CODE, missing: [] };
  if (e.missing.length) return { status: 409, error: solveBlockMessage(e.missing), code: SOLVE_BLOCK_CODE, missing: e.missing };
  return null;
}

const FACT_COLS = "id, team_id, request_type_id, assignee_id, category, tags, first_replied_at, source";

/** The field changes a solve makes in the same step (the desk's quick setters, a macro's, the API's). */
export type SolveFieldPatch = { team_id?: number | null; assignee_id?: number | null; category?: string; tags?: string[] };

function withPatch(t: SolveTicketFacts, p: SolveFieldPatch | undefined): SolveTicketFacts {
  if (!p) return t;
  return {
    ...t,
    team_id: p.team_id !== undefined ? p.team_id : t.team_id,
    assignee_id: p.assignee_id !== undefined ? p.assignee_id : t.assignee_id,
    category: p.category !== undefined ? p.category : t.category,
    tags: p.tags !== undefined ? p.tags : t.tags,
  };
}

/**
 * May this ticket be solved as far as the requirement sets go? Null when
 * yes; otherwise the refusal. For the routes that would write something
 * first (a reply, a macro's reply) and for the workflow's Finish step;
 * updateTicket enforces it (applySolveRequirementsTx). Pass `client` and
 * `snapshot` from inside a transaction.
 */
export async function solveRequirementRefusal(
  ticketId: number,
  opts: { client?: HdQueryable; snapshot?: SolveSetsSnapshot; answers?: unknown; patch?: SolveFieldPatch; replyPending?: boolean } = {}
): Promise<SolveRefusal | null> {
  const snap = opts.snapshot ?? (opts.client ? await solveSetsSnapshotTx(opts.client) : await solveSetsSnapshot());
  if (!snap.sets.length) return null;
  const t = await hqOne<SolveTicketFacts>(`SELECT ${FACT_COLS} FROM hd_tickets WHERE id = $1`, [ticketId], opts.client);
  if (!t) return null;
  return refusalOf(await evaluateSolve(snap, withPatch(t, opts.patch), { client: opts.client, answers: opts.answers, replyPending: opts.replyPending }));
}

/**
 * lib/helpdesk/tickets updateTicket, inside its transaction, when the change
 * leaves the open statuses for solved or closed: the refusal, or null once
 * the answers sent with the solve are stored. `line` is the internal
 * timeline line to add ("Ana filled in the solve details: Resolution code,
 * Root cause"), when anything was stored.
 */
export async function applySolveRequirementsTx(
  client: HdQueryable,
  snap: SolveSetsSnapshot,
  t: SolveTicketFacts,
  opts: { from: HdStatus; to: HdStatus; answers?: unknown; actor: { id: number | null; name: string }; now: Date }
): Promise<{ refusal: SolveRefusal | null; line: string | null }> {
  if (!solvesForRequirements(opts.from, opts.to)) return { refusal: null, line: null };
  const e = await evaluateSolve(snap, t, { client, answers: opts.answers });
  const refusal = refusalOf(e);
  if (refusal || !e.applies) return { refusal, line: null };
  for (const c of e.clears) {
    await client.query("DELETE FROM hd_ticket_solve_answers WHERE ticket_id = $1 AND set_id = $2 AND field_key = $3", [t.id, c.set_id, c.key]);
  }
  if (!e.upserts.length) return { refusal: null, line: null };
  // People's names for "A person" answers, in one read.
  const ids = [...new Set(e.upserts.filter((u) => u.field.type === "user" && typeof u.value === "number").map((u) => u.value as number))];
  const names = new Map<number, string>();
  if (ids.length) {
    for (const r of await hq<{ id: number; name: string }>("SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [ids], client)) names.set(r.id, r.name);
  }
  for (const u of e.upserts) {
    await client.query(
      `INSERT INTO hd_ticket_solve_answers (ticket_id, set_id, field_key, set_name, label, type, value, display, position, answered_by, answered_by_name, answered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       ON CONFLICT (ticket_id, set_id, field_key) DO UPDATE
         SET set_name = EXCLUDED.set_name, label = EXCLUDED.label, type = EXCLUDED.type, value = EXCLUDED.value, display = EXCLUDED.display,
             position = EXCLUDED.position, answered_by = EXCLUDED.answered_by, answered_by_name = EXCLUDED.answered_by_name, answered_at = EXCLUDED.answered_at`,
      [t.id, u.set_id, u.field.key, u.set_name, u.field.label, u.field.type, JSON.stringify(u.value), displayOf(u.field, u.value, names), u.position, opts.actor.id, opts.actor.name, opts.now]
    );
  }
  const labels = [...new Set(e.upserts.map((u) => u.field.label))];
  const shown = labels.slice(0, 6).map((l) => mdInline(l)).join(", ");
  const line = `${mdInline(opts.actor.name) || "Someone"} filled in the solve details: ${shown}${labels.length > 6 ? ` and ${labels.length - 6} more` : ""}`;
  return { refusal: null, line };
}

// --- Reads --------------------------------------------------------------------------------

/** A ticket's answers, in set and field order (the side panel's "Solve details", the print view, the webhook). */
export async function ticketSolveDetails(ticketId: number, client?: HdQueryable): Promise<HdSolveDetail[]> {
  return (await storedAnswers(ticketId, client)).map((a) => ({
    set_id: a.set_id,
    set_name: a.set_name,
    key: a.field_key,
    label: a.label,
    type: a.type,
    value: a.value,
    text: a.display,
    answered_by_name: a.answered_by_name,
    answered_at: a.answered_at,
  }));
}

/** The answers as integrations read them (the API, the ticket.solved webhook, the Claude connector). */
export async function solveDetailsOut(ticketId: number): Promise<{ set: string; key: string; label: string; value: HdFormAnswers[string]; text: string }[]> {
  return (await ticketSolveDetails(ticketId)).map((d) => ({ set: d.set_name, key: d.key, label: d.label, value: d.value, text: d.text }));
}

/** Does some switched-on set match this ticket? (The ticket detail's `before_solve`: the desk asks before a solve only then.) */
export async function solveSetsApplyTo(t: { team_id: number | null; request_type_id: number | null; source: string }): Promise<boolean> {
  const snap = await solveSetsSnapshot();
  return t.source !== "workflow" && snap.sets.some((s) => solveSetMatches(s, t));
}

/**
 * GET / POST /api/helpdesk/tickets/[number]/solve-requirements: what a solve
 * needs now, for the "Before you solve" dialog. With `answers` and `patch`
 * it is the dialog's check before it submits (nothing is stored).
 */
export async function solveCheckFor(
  ticket: SolveTicketFacts & { team_name?: string | null },
  opts: { answers?: unknown; patch?: SolveFieldPatch; replyPending?: boolean } = {}
): Promise<HdSolveCheck & { invalid: string | null }> {
  const snap = await solveSetsSnapshot();
  const facts = withPatch(ticket, opts.patch);
  const e = await evaluateSolve(snap, facts, { answers: opts.answers, replyPending: opts.replyPending });
  const names: Record<string, string> = {};
  const people = e.sets.flatMap((s) => s.fields.filter((f) => f.type === "user").map((f) => solveAnswerKey(s.id, f.key))).filter((k) => typeof e.answers[k] === "number");
  if (people.length) {
    const rows = await hq<{ id: number; name: string }>("SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [people.map((k) => e.answers[k] as number)]);
    for (const k of people) names[k] = rows.find((r) => r.id === e.answers[k])?.name ?? "";
  }
  return {
    applies: e.applies,
    sets: e.sets,
    missing: e.missing,
    error: e.missing.length ? solveBlockMessage(e.missing) : null,
    optional_open: e.optionalOpen,
    answers: e.answers,
    answer_names: names,
    ticket: { team_id: ticket.team_id, team_name: ticket.team_name ?? null, assignee_id: ticket.assignee_id, category: ticket.category ?? "", tags: ticket.tags ?? [] },
    invalid: e.invalid,
  };
}

/**
 * hd_read_ticket (agents): the answers kept, and what a solve would still
 * need, with each closing field's key, type and options so `solve_answers`
 * can be sent with hd_update_ticket.
 */
export async function solveRequirementsForMcp(ticket: SolveTicketFacts & { status: HdStatus }) {
  const details = await solveDetailsOut(ticket.id);
  if (ticket.status === "solved" || ticket.status === "closed") return { solve_details: details };
  const c = await solveCheckFor(ticket);
  if (!c.applies) return { solve_details: details };
  return {
    solve_details: details,
    before_you_solve: {
      needed_now: c.error,
      ticket_fields: c.sets.flatMap((s) => s.ticket_fields).filter((f, i, all) => all.findIndex((x) => x.field === f.field) === i).map((f) => ({ field: f.field, label: f.label, met: f.met })),
      closing_fields: c.sets.flatMap((s) =>
        s.fields.map((f) => ({
          set: s.name,
          key: f.key,
          label: f.label,
          type: f.type,
          required: !!f.required,
          ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
          answered: Object.prototype.hasOwnProperty.call(c.answers, solveAnswerKey(s.id, f.key)),
        }))
      ),
    },
  };
}

// --- Retention ---------------------------------------------------------------------------

/**
 * lib/helpdesk/retention anonymiseTicketTx: free text and people's names go,
 * as the request form's answers do. Choices, numbers, dates and ticks stay
 * for reporting (a resolution code names nobody).
 */
export async function anonymiseSolveAnswersTx(client: HdQueryable, ticketId: number): Promise<void> {
  await client.query("DELETE FROM hd_ticket_solve_answers WHERE ticket_id = $1 AND type IN ('text', 'textarea', 'user')", [ticketId]);
}
