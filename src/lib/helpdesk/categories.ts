// Helpdesk 1.20.6: managed categories and sub-categories. Schema:
// lib/helpdesk/categories-schema; the pure half (limits, name rules, how a
// pick is checked): lib/helpdesk/categories-shared. Server-only.
//
//   - The desk admin keeps a list of categories, each with sub-categories
//     (Desk settings → Categories). Wherever a category is set on a ticket
//     (the side panel, a request type, an automation, the API, the Claude
//     connector) it must be on the list and not archived; anything else is
//     refused with a 400 that names the allowed values. Nothing invents a
//     category.
//   - Tickets, request types and rules carry the NAME, as they always have.
//     One fact, so a 1.20.5 binary on the same database reads and writes it
//     unchanged. Renaming or merging a list entry rewrites the name where it
//     is carried (tickets, request types, automations, saved views, report
//     filters) in the same transaction as the list change. Timeline lines
//     are history: they keep the words they were written with.
//   - Upgrade, and every start after it: every category already on a ticket,
//     a request type or an automation that is not on the list joins it
//     (adoptCategories, once per process, and again whenever the settings
//     page is opened). Spellings that differ only by case or outer spaces
//     become one entry, in the spelling most tickets use, and the tickets
//     and request types are brought to that spelling. A sub-category that is
//     not listed under its ticket's category (a 1.20.5 binary changed the
//     category meanwhile) is cleared.
//   - Archive hides an entry from pickers and keeps it on the tickets that
//     have it. It is refused while a request type or an automation still
//     sets it, so no new ticket is ever given an archived category. Delete
//     is for an entry nothing uses; "Merge into…" moves the tickets, request
//     types and rules to another entry and removes this one.
//
// The list is the workspace's configuration, not personal data: retention,
// anonymise and the personal data export leave it alone.

import "server-only";
import type { PoolClient } from "pg";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import {
  CATEGORY_LIMITS,
  CATEGORY_SEP,
  categoryInUse,
  categoryKey,
  categoryNameProblem,
  cleanCategoryName,
  resolveCategoryPick,
} from "./categories-shared";
import type { CategoryPick, HdCategory, HdCategoryAdmin, HdCategoryUse } from "./categories-shared";

export class HdCategoryError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

interface Row {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
  archived_at: string | null;
}

/** One advisory lock for every change to the list (and the adoption), so two never interleave. */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(728346)";
/**
 * The same lock, shared: taken by a ticket change that sets a category, FIRST
 * in its transaction (before the ticket row is locked), so a rename or merge
 * waits for it and it for them. Without it a change checked against the list
 * just before a rename could store the old name just after it.
 */
export const CATEGORY_LIST_SHARED_LOCK_SQL = "SELECT pg_advisory_xact_lock_shared(728346)";

// --- Reads -------------------------------------------------------------------------

async function rows(client?: HdQueryable): Promise<Row[]> {
  return hq<Row>("SELECT id, parent_id, name, position, archived_at FROM hd_categories ORDER BY position, lower(name), id", [], client);
}

function treeOf(all: Row[]): HdCategory[] {
  return all
    .filter((r) => r.parent_id === null)
    .map((c) => ({
      id: c.id,
      name: c.name,
      archived: c.archived_at !== null,
      subcategories: all.filter((s) => s.parent_id === c.id).map((s) => ({ id: s.id, name: s.name, archived: s.archived_at !== null })),
    }));
}

/**
 * The whole list, archived entries included, in the admin's order. Pass
 * `client` inside a transaction (no adoption runs then: the caller's write
 * is checked against the list as it stands).
 */
export async function categoryTree(client?: HdQueryable): Promise<HdCategory[]> {
  if (!client) await categoriesReady();
  return treeOf(await rows(client));
}

/** The list as pickers offer it: nothing archived. */
export async function activeCategories(): Promise<HdCategory[]> {
  return (await categoryTree()).filter((c) => !c.archived).map((c) => ({ ...c, subcategories: c.subcategories.filter((s) => !s.archived) }));
}

/**
 * Check a category and sub-category someone wants to set against the list,
 * as resolveCategoryPick does. `current` is what is held now (kept as it is).
 */
export async function checkCategoryPick(
  want: { category: string; subcategory?: string },
  current: { category?: string; subcategory?: string } = {},
  client?: HdQueryable
): Promise<CategoryPick> {
  return resolveCategoryPick(await categoryTree(client), want, current);
}

// --- What uses an entry ------------------------------------------------------------

interface AutomationRow {
  id: number;
  name: string;
  conditions: { categories?: string[]; subcategories?: { category: string; subcategory: string }[] } & Record<string, unknown>;
  actions: { category?: string; subcategory?: string } & Record<string, unknown>;
}

async function automationRows(client?: HdQueryable): Promise<AutomationRow[]> {
  return hq<AutomationRow>("SELECT id, name, conditions, actions FROM hd_automations ORDER BY position, id", [], client);
}

const pairKey = (category: string, subcategory: string) => `${categoryKey(category)}\u0000${categoryKey(subcategory)}`;

interface UseIndex {
  /** By category key: every ticket of the category, whatever its sub-category. */
  category: Map<string, HdCategoryUse>;
  /** By pair key. */
  pair: Map<string, HdCategoryUse>;
  /** The automations whose ACTION sets it (what stops an archive), by category key and by pair key. */
  setBy: Map<string, string[]>;
  /** The request types that set it, by category key and by pair key. */
  typeBy: Map<string, string[]>;
}

async function useIndex(client?: HdQueryable): Promise<UseIndex> {
  const idx: UseIndex = { category: new Map(), pair: new Map(), setBy: new Map(), typeBy: new Map() };
  const at = (m: Map<string, HdCategoryUse>, k: string) => {
    let u = m.get(k);
    if (!u) m.set(k, (u = { tickets: 0, request_types: 0, automations: 0 }));
    return u;
  };
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  // One after the other: inside a transaction they share one connection.
  const tickets = await hq<{ category: string; subcategory: string; n: number }>(
    "SELECT category, subcategory, count(*)::int AS n FROM hd_tickets WHERE category <> '' GROUP BY category, subcategory",
    [],
    client
  );
  const types = await hq<{ title: string; category: string; subcategory: string }>("SELECT title, category, subcategory FROM hd_request_types WHERE category <> ''", [], client);
  const autos = await automationRows(client);
  for (const t of tickets) {
    at(idx.category, categoryKey(t.category)).tickets += t.n;
    if (t.subcategory) at(idx.pair, pairKey(t.category, t.subcategory)).tickets += t.n;
  }
  for (const t of types) {
    at(idx.category, categoryKey(t.category)).request_types += 1;
    push(idx.typeBy, categoryKey(t.category), t.title);
    if (t.subcategory) {
      at(idx.pair, pairKey(t.category, t.subcategory)).request_types += 1;
      push(idx.typeBy, pairKey(t.category, t.subcategory), t.title);
    }
  }
  for (const a of autos) {
    const cats = new Set<string>();
    const pairs = new Set<string>();
    if (a.actions?.category) {
      cats.add(categoryKey(a.actions.category));
      push(idx.setBy, categoryKey(a.actions.category), a.name);
      if (a.actions.subcategory) {
        pairs.add(pairKey(a.actions.category, a.actions.subcategory));
        push(idx.setBy, pairKey(a.actions.category, a.actions.subcategory), a.name);
      }
    }
    for (const c of a.conditions?.categories ?? []) cats.add(categoryKey(c));
    for (const p of a.conditions?.subcategories ?? []) {
      cats.add(categoryKey(p.category));
      pairs.add(pairKey(p.category, p.subcategory));
    }
    for (const k of cats) at(idx.category, k).automations += 1;
    for (const k of pairs) at(idx.pair, k).automations += 1;
  }
  return idx;
}

const NO_USE: HdCategoryUse = { tickets: 0, request_types: 0, automations: 0 };

/** The settings page's list: every entry with what uses it. Takes in anything typed since the last start first. */
export async function listCategoriesAdmin(): Promise<HdCategoryAdmin[]> {
  await adoptCategories();
  const [tree, idx] = await Promise.all([treeOf(await rows()), useIndex()]);
  return tree.map((c) => ({
    ...c,
    use: idx.category.get(categoryKey(c.name)) ?? NO_USE,
    subcategories: c.subcategories.map((s) => ({ ...s, use: idx.pair.get(pairKey(c.name, s.name)) ?? NO_USE })),
  }));
}

// --- Upgrade: take in what is already in use ------------------------------------------

/** A stored name as cleanCategoryName leaves it: outer spaces off, inner runs of white space as one space. */
const CLEAN_SQL = (col: string) => `btrim(regexp_replace(${col}, '\\s+', ' ', 'g'))`;

export interface AdoptResult {
  /** Categories added to the list. */
  added: string[];
  /** Tickets and request types brought to the list's spelling. */
  respelled: number;
  /** Sub-categories cleared because their category does not list them. */
  cleared: number;
}

/**
 * Put every category in use on the list. Idempotent; one transaction under
 * the list's lock. Sources: hd_tickets.category, hd_request_types.category
 * and the categories automations name. Names that differ only by case or
 * outer spaces are one entry: the list's spelling if it has one, else the
 * spelling most tickets use (then a request type's, then a rule's).
 */
export async function adoptCategories(): Promise<AdoptResult> {
  const out = await withTx(async (client) => {
    await client.query(LOCK_SQL);
    const autos = await automationRows(client);
    const ruleNames = new Set<string>();
    for (const a of autos) {
      if (typeof a.actions?.category === "string") ruleNames.add(cleanCategoryName(a.actions.category));
      for (const c of a.conditions?.categories ?? []) if (typeof c === "string") ruleNames.add(cleanCategoryName(c));
    }
    ruleNames.delete("");
    const added = await hq<{ name: string }>(
      `WITH seen AS (
         SELECT ${CLEAN_SQL("category")} AS name, count(*)::int AS n, 0 AS src FROM hd_tickets WHERE ${CLEAN_SQL("category")} <> '' GROUP BY 1
         UNION ALL
         SELECT ${CLEAN_SQL("category")}, 0, 1 FROM hd_request_types WHERE ${CLEAN_SQL("category")} <> ''
         UNION ALL
         SELECT x, 0, 2 FROM unnest($1::text[]) AS x
       ), spelt AS (
         SELECT name, sum(n) AS n, min(src) AS src FROM seen GROUP BY name
       ), best AS (
         SELECT DISTINCT ON (lower(name)) name FROM spelt ORDER BY lower(name), src, n DESC, name
       )
       INSERT INTO hd_categories (name, position)
       SELECT b.name, (SELECT COALESCE(max(position), 0) FROM hd_categories WHERE parent_id IS NULL) + row_number() OVER (ORDER BY lower(b.name))
         FROM best b
        WHERE NOT EXISTS (SELECT 1 FROM hd_categories c WHERE c.parent_id IS NULL AND lower(c.name) = lower(b.name))
       ON CONFLICT DO NOTHING
       RETURNING name`,
      [[...ruleNames]],
      client
    );
    // The list's spelling on every ticket and request type (case and spacing only).
    let respelled = 0;
    for (const table of ["hd_tickets", "hd_request_types"]) {
      const r = await client.query(
        `UPDATE ${table} t SET category = c.name
           FROM hd_categories c
          WHERE c.parent_id IS NULL AND t.category <> '' AND t.category <> c.name AND lower(${CLEAN_SQL("t.category")}) = lower(c.name)`
      );
      respelled += r.rowCount ?? 0;
      const s = await client.query(
        `UPDATE ${table} t SET subcategory = s.name
           FROM hd_categories c JOIN hd_categories s ON s.parent_id = c.id
          WHERE c.parent_id IS NULL AND t.subcategory <> '' AND t.subcategory <> s.name
            AND lower(t.category) = lower(c.name) AND lower(${CLEAN_SQL("t.subcategory")}) = lower(s.name)`
      );
      respelled += s.rowCount ?? 0;
    }
    // A sub-category its category does not list: cleared.
    let cleared = 0;
    for (const table of ["hd_tickets", "hd_request_types"]) {
      const r = await client.query(
        `UPDATE ${table} t SET subcategory = ''
          WHERE t.subcategory <> ''
            AND NOT EXISTS (SELECT 1 FROM hd_categories c JOIN hd_categories s ON s.parent_id = c.id
                             WHERE c.parent_id IS NULL AND lower(c.name) = lower(t.category) AND lower(s.name) = lower(t.subcategory))`
      );
      cleared += r.rowCount ?? 0;
    }
    return { added: added.map((a) => a.name), respelled, cleared };
  });
  if (out.added.length || out.respelled || out.cleared) {
    logEvent("info", "helpdesk.categories_adopted", { added: out.added.length, respelled: out.respelled, cleared: out.cleared });
  }
  if (out.added.length) {
    // Said in the audit log, so an admin can see where the list came from.
    const { audit } = await import("../audit");
    await audit({
      actor: { name: "system" },
      action: "helpdesk.category.adopted",
      targetType: "helpdesk_category",
      targetLabel: `${out.added.length} ${out.added.length === 1 ? "category" : "categories"}`,
      details: { added: out.added.slice(0, 200), count: out.added.length, respelled: out.respelled },
    });
  }
  return out;
}

let readyPromise: Promise<void> | null = null;

/** Wait for the schema and take in the categories already in use. Once per process (a failure is retried on the next call). */
export function categoriesReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = adoptCategories()
      .then(() => undefined)
      .catch((e) => {
        readyPromise = null;
        throw e;
      });
  }
  return readyPromise;
}

/** Tests: run the adoption again on the next read. */
export function resetCategoriesReadyForTests(): void {
  readyPromise = null;
}

// --- Changes to the list ---------------------------------------------------------------

export interface CategoryChange {
  id: number;
  name: string;
  /** The category a sub-category belongs to. */
  parent: { id: number; name: string } | null;
}

async function entry(client: HdQueryable, id: number): Promise<(Row & { parent_name: string | null }) | undefined> {
  return hqOne<Row & { parent_name: string | null }>(
    `SELECT c.id, c.parent_id, c.name, c.position, c.archived_at, p.name AS parent_name
       FROM hd_categories c LEFT JOIN hd_categories p ON p.id = c.parent_id WHERE c.id = $1`,
    [id],
    client
  );
}

const changeOf = (r: Row & { parent_name: string | null }): CategoryChange => ({
  id: r.id,
  name: r.name,
  parent: r.parent_id ? { id: r.parent_id, name: r.parent_name ?? "" } : null,
});

const noun = (r: { parent_id: number | null }) => (r.parent_id ? "sub-category" : "category");

/** Add a category, or (`parent_id`) a sub-category of one. */
export async function createCategory(input: { name: unknown; parent_id?: unknown }, actor: { id: number | null }): Promise<CategoryChange> {
  await categoriesReady();
  const name = cleanCategoryName(input.name);
  const parentId = input.parent_id === undefined || input.parent_id === null ? null : Number(input.parent_id);
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw new HdCategoryError("That category does not exist.", 404);
  const problem = categoryNameProblem(name, parentId ? "sub-category" : "category");
  if (problem) throw new HdCategoryError(problem);
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const all = await rows(client);
    let parent: Row | undefined;
    if (parentId !== null) {
      parent = all.find((r) => r.id === parentId);
      if (!parent || parent.parent_id !== null) throw new HdCategoryError("That category does not exist.", 404);
    }
    const level = all.filter((r) => r.parent_id === parentId);
    if (level.some((r) => categoryKey(r.name) === categoryKey(name))) {
      throw new HdCategoryError(parent ? `${parent.name} already has a sub-category called "${name}".` : `There is already a category called "${name}".`, 409);
    }
    const max = parent ? CATEGORY_LIMITS.subcategories : CATEGORY_LIMITS.categories;
    if (level.length >= max) throw new HdCategoryError(parent ? `A category holds up to ${max} sub-categories.` : `The list holds up to ${max} categories.`, 409);
    const position = level.reduce((m, r) => Math.max(m, r.position), 0) + 1;
    const made = (
      await hq<Row>(
        "INSERT INTO hd_categories (parent_id, name, position, created_by) VALUES ($1, $2, $3, $4) RETURNING id, parent_id, name, position, archived_at",
        [parentId, name, position, actor.id],
        client
      )
    )[0];
    return { id: made.id, name: made.name, parent: parent ? { id: parent.id, name: parent.name } : null };
  });
}

/** Replace a name wherever a rule, a saved view or a report filter carries it. */
async function rewriteCarriers(
  client: PoolClient,
  /** Maps a (category, sub-category) as carried to what it becomes; null = leave it. `subcategory` '' = the category alone. */
  map: (category: string, subcategory: string) => { category: string; subcategory: string } | null
): Promise<void> {
  // Automations: the action's category and sub-category, the conditions' lists.
  for (const a of await automationRows(client)) {
    let touched = false;
    const actions = { ...a.actions };
    if (typeof actions.category === "string" && actions.category) {
      const to = map(actions.category, typeof actions.subcategory === "string" ? actions.subcategory : "");
      if (to) {
        actions.category = to.category;
        if (to.subcategory) actions.subcategory = to.subcategory;
        else delete actions.subcategory;
        touched = true;
      }
    }
    const conditions = { ...a.conditions };
    const cats: string[] = [];
    const pairs: { category: string; subcategory: string }[] = [];
    const addCat = (c: string) => {
      if (!cats.some((x) => categoryKey(x) === categoryKey(c))) cats.push(c);
    };
    const addPair = (c: string, s: string) => {
      if (!pairs.some((x) => pairKey(x.category, x.subcategory) === pairKey(c, s))) pairs.push({ category: c, subcategory: s });
    };
    for (const c of conditions.categories ?? []) {
      const to = map(c, "");
      if (to) touched = true;
      if (to?.subcategory) addPair(to.category, to.subcategory);
      else addCat(to?.category ?? c);
    }
    for (const p of conditions.subcategories ?? []) {
      const to = map(p.category, p.subcategory);
      if (to) touched = true;
      const next = to ?? p;
      if (next.subcategory) addPair(next.category, next.subcategory);
      else addCat(next.category);
    }
    if (!touched) continue;
    if (cats.length) conditions.categories = cats;
    else delete conditions.categories;
    if (pairs.length) conditions.subcategories = pairs;
    else delete conditions.subcategories;
    await client.query("UPDATE hd_automations SET conditions = $2, actions = $3, updated_at = now() WHERE id = $1", [a.id, JSON.stringify(conditions), JSON.stringify(actions)]);
  }
  // Saved views: filters.category, and filters.subcategory ("Category › Sub-category", or a bare sub-category).
  const views = await hq<{ id: number; filters: Record<string, string> }>(
    "SELECT id, filters FROM hd_saved_views WHERE filters ? 'category' OR filters ? 'subcategory'",
    [],
    client
  );
  for (const v of views) {
    const f = { ...v.filters };
    let touched = false;
    const sub = typeof f.subcategory === "string" ? f.subcategory : "";
    const split = sub.includes(CATEGORY_SEP) ? { category: sub.slice(0, sub.indexOf(CATEGORY_SEP)), subcategory: sub.slice(sub.indexOf(CATEGORY_SEP) + CATEGORY_SEP.length) } : null;
    if (split) {
      const to = map(split.category, split.subcategory);
      if (to) {
        touched = true;
        if (to.subcategory) f.subcategory = `${to.category}${CATEGORY_SEP}${to.subcategory}`;
        else {
          delete f.subcategory;
          f.category = to.category;
        }
      }
    } else if (sub && sub !== "none" && typeof f.category === "string" && f.category && f.category !== "none") {
      const to = map(f.category, sub);
      if (to) {
        touched = true;
        f.category = to.category;
        if (to.subcategory) f.subcategory = to.subcategory;
        else delete f.subcategory;
      }
    }
    if (!touched && typeof f.category === "string" && f.category && f.category !== "none") {
      const to = map(f.category, "");
      if (to) {
        touched = true;
        f.category = to.category;
        if (to.subcategory && !f.subcategory) f.subcategory = to.subcategory;
      }
    }
    if (touched) await client.query("UPDATE hd_saved_views SET filters = $2, updated_at = now() WHERE id = $1", [v.id, JSON.stringify(f)]);
  }
  // Report dashboards: the category filter of the dashboard and of each widget (a list of names).
  const boards = await hq<{ id: number; layout: { filters?: { category?: unknown }; widgets?: { filters?: { category?: unknown } }[] } }>(
    "SELECT id, layout FROM hd_dashboards WHERE layout::text LIKE '%\"category\"%'",
    [],
    client
  );
  for (const b of boards) {
    let touched = false;
    const fix = (f: { category?: unknown } | undefined) => {
      if (!f || !Array.isArray(f.category)) return;
      const next: string[] = [];
      for (const c of f.category as unknown[]) {
        if (typeof c !== "string") continue;
        const to = map(c, "");
        if (to) touched = true;
        const name = to?.category ?? c;
        if (!next.some((x) => categoryKey(x) === categoryKey(name))) next.push(name);
      }
      f.category = next;
    };
    fix(b.layout?.filters);
    for (const w of b.layout?.widgets ?? []) fix(w?.filters);
    if (touched) await client.query("UPDATE hd_dashboards SET layout = $2 WHERE id = $1", [b.id, JSON.stringify(b.layout)]);
  }
}

export interface RenameResult {
  before: CategoryChange;
  after: CategoryChange;
  /** Tickets whose category (or sub-category) now reads the new name. */
  tickets: number;
}

/**
 * Rename an entry. The new name replaces the old one on every ticket,
 * request type, automation, saved view and report filter that carries it,
 * in this transaction. Timeline lines keep the words they were written with.
 */
export async function renameCategory(id: number, rawName: unknown): Promise<RenameResult | undefined> {
  await categoriesReady();
  const name = cleanCategoryName(rawName);
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const before = await entry(client, id);
    if (!before) return undefined;
    const problem = categoryNameProblem(name, noun(before));
    if (problem) throw new HdCategoryError(problem);
    if (name === before.name) return { before: changeOf(before), after: changeOf(before), tickets: 0 };
    const clash = await hqOne<{ id: number }>(
      "SELECT id FROM hd_categories WHERE COALESCE(parent_id, 0) = $1 AND lower(name) = lower($2) AND id <> $3",
      [before.parent_id ?? 0, name, id],
      client
    );
    if (clash) {
      throw new HdCategoryError(
        before.parent_id
          ? `${before.parent_name} already has a sub-category called "${name}". Use Merge into… to bring the two together.`
          : `There is already a category called "${name}". Use Merge into… to bring the two together.`,
        409
      );
    }
    await client.query("UPDATE hd_categories SET name = $2, updated_at = now() WHERE id = $1", [id, name]);
    let tickets = 0;
    if (before.parent_id === null) {
      for (const table of ["hd_tickets", "hd_request_types"]) {
        const r = await client.query(`UPDATE ${table} SET category = $2 WHERE lower(category) = lower($1)`, [before.name, name]);
        if (table === "hd_tickets") tickets = r.rowCount ?? 0;
      }
      await rewriteCarriers(client, (c, s) => (categoryKey(c) === categoryKey(before.name) ? { category: name, subcategory: s } : null));
    } else {
      const parent = before.parent_name ?? "";
      for (const table of ["hd_tickets", "hd_request_types"]) {
        const r = await client.query(`UPDATE ${table} SET subcategory = $3 WHERE lower(category) = lower($1) AND lower(subcategory) = lower($2)`, [parent, before.name, name]);
        if (table === "hd_tickets") tickets = r.rowCount ?? 0;
      }
      await rewriteCarriers(client, (c, s) => (pairKey(c, s) === pairKey(parent, before.name) ? { category: c, subcategory: name } : null));
    }
    return { before: changeOf(before), after: { ...changeOf(before), name }, tickets };
  });
}

/** Archive (hide from pickers) or restore an entry. */
export async function setCategoryArchived(id: number, archived: boolean): Promise<{ entry: CategoryChange; changed: boolean } | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const e = await entry(client, id);
    if (!e) return undefined;
    if ((e.archived_at !== null) === archived) return { entry: changeOf(e), changed: false };
    if (archived) {
      // Nothing may keep setting an archived entry on new tickets.
      const idx = await useIndex(client);
      const k = e.parent_id === null ? categoryKey(e.name) : pairKey(e.parent_name ?? "", e.name);
      const types = idx.typeBy.get(k) ?? [];
      const autos = idx.setBy.get(k) ?? [];
      if (types.length || autos.length) {
        const parts: string[] = [];
        const quote = (names: string[]) => names.slice(0, 3).map((n) => `"${n}"`).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
        if (types.length) parts.push(`${types.length === 1 ? "the request type" : "the request types"} ${quote(types)}`);
        if (autos.length) parts.push(`${autos.length === 1 ? "the automation" : "the automations"} ${quote(autos)}`);
        throw new HdCategoryError(`New tickets still get this ${noun(e)} from ${parts.join(" and ")}. Change ${types.length + autos.length === 1 ? "it" : "those"} first, then archive.`, 409);
      }
    }
    await client.query("UPDATE hd_categories SET archived_at = $2, updated_at = now() WHERE id = $1", [id, archived ? new Date() : null]);
    return { entry: changeOf(e), changed: true };
  });
}

/** Move an entry one place up or down within its level. */
export async function moveCategory(id: number, direction: "up" | "down"): Promise<{ entry: CategoryChange; moved: boolean; order: string[] } | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const e = await entry(client, id);
    if (!e) return undefined;
    const level = (await rows(client)).filter((r) => r.parent_id === e.parent_id);
    const i = level.findIndex((r) => r.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= level.length) return { entry: changeOf(e), moved: false, order: level.map((r) => r.name) };
    [level[i], level[j]] = [level[j], level[i]];
    // Renumber the level, so positions that tied (an upgrade's batch) come apart.
    for (let n = 0; n < level.length; n++) {
      if (level[n].position !== n + 1) await client.query("UPDATE hd_categories SET position = $2 WHERE id = $1", [level[n].id, n + 1]);
    }
    return { entry: changeOf(e), moved: true, order: level.map((r) => r.name) };
  });
}

/** Delete an entry nothing uses. A category goes with its (unused) sub-categories. */
export async function deleteCategory(id: number): Promise<CategoryChange | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const e = await entry(client, id);
    if (!e) return undefined;
    const idx = await useIndex(client);
    const use = (e.parent_id === null ? idx.category.get(categoryKey(e.name)) : idx.pair.get(pairKey(e.parent_name ?? "", e.name))) ?? NO_USE;
    if (categoryInUse(use)) {
      const parts: string[] = [];
      if (use.tickets) parts.push(`${use.tickets} ${use.tickets === 1 ? "ticket" : "tickets"}`);
      if (use.request_types) parts.push(`${use.request_types} ${use.request_types === 1 ? "request type" : "request types"}`);
      if (use.automations) parts.push(`${use.automations} ${use.automations === 1 ? "automation" : "automations"}`);
      throw new HdCategoryError(`This ${noun(e)} is still used by ${parts.join(", ")}. Merge it into another one to move them, or archive it to keep it on old tickets.`, 409);
    }
    await client.query("DELETE FROM hd_categories WHERE id = $1", [id]);
    return changeOf(e);
  });
}

export interface MergeResult {
  from: CategoryChange;
  into: CategoryChange;
  /** Tickets moved. */
  tickets: number;
  request_types: number;
  /** Sub-categories that moved under the kept category (a category merge). */
  moved_subcategories: string[];
}

/**
 * Merge an entry into another and remove it. Every ticket, request type,
 * automation, saved view and report filter that carried it carries the
 * other one from here on.
 *   - A category into a category: its tickets take the kept category; a
 *     sub-category the kept one already lists (by name) is merged into it,
 *     the others move under the kept category.
 *   - A sub-category into a sub-category (of any category), or into a
 *     category alone (its tickets keep the category and lose the sub-category).
 */
export async function mergeCategory(id: number, intoId: number): Promise<MergeResult | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(LOCK_SQL);
    const from = await entry(client, id);
    const into = await entry(client, intoId);
    if (!from) return undefined;
    if (!into) throw new HdCategoryError("Pick what to merge it into.", 400);
    if (from.id === into.id) throw new HdCategoryError("Pick a different one to merge it into.");
    if (from.parent_id === null && into.parent_id !== null) throw new HdCategoryError("A category can only be merged into another category.");
    if (into.archived_at !== null) throw new HdCategoryError(`"${into.name}" is archived. Restore it first, then merge into it.`, 409);
    if (into.parent_id !== null) {
      const parent = await entry(client, into.parent_id);
      if (parent?.archived_at) throw new HdCategoryError(`"${parent.name}" is archived. Restore it first, then merge into it.`, 409);
    }
    let tickets = 0;
    let requestTypes = 0;
    const movedSubs: string[] = [];
    if (from.parent_id === null) {
      const all = await rows(client);
      const fromSubs = all.filter((r) => r.parent_id === from.id);
      const intoSubs = all.filter((r) => r.parent_id === into.id);
      let position = intoSubs.reduce((m, r) => Math.max(m, r.position), 0);
      const subMap = new Map<string, string>();
      for (const s of fromSubs) {
        const twin = intoSubs.find((r) => categoryKey(r.name) === categoryKey(s.name));
        if (twin) subMap.set(categoryKey(s.name), twin.name);
        else {
          position += 1;
          await client.query("UPDATE hd_categories SET parent_id = $2, position = $3, updated_at = now() WHERE id = $1", [s.id, into.id, position]);
          movedSubs.push(s.name);
          subMap.set(categoryKey(s.name), s.name);
        }
      }
      for (const table of ["hd_tickets", "hd_request_types"]) {
        // The kept category's spelling of a sub-category both list.
        for (const s of fromSubs) {
          const to = subMap.get(categoryKey(s.name))!;
          if (to !== s.name) await client.query(`UPDATE ${table} SET subcategory = $3 WHERE lower(category) = lower($1) AND lower(subcategory) = lower($2)`, [from.name, s.name, to]);
        }
        const r = await client.query(`UPDATE ${table} SET category = $2 WHERE lower(category) = lower($1)`, [from.name, into.name]);
        if (table === "hd_tickets") tickets = r.rowCount ?? 0;
        else requestTypes = r.rowCount ?? 0;
      }
      await rewriteCarriers(client, (c, s) =>
        categoryKey(c) === categoryKey(from.name) ? { category: into.name, subcategory: s ? (subMap.get(categoryKey(s)) ?? s) : "" } : null
      );
    } else {
      const fromParent = from.parent_name ?? "";
      const target = into.parent_id === null ? { category: into.name, subcategory: "" } : { category: into.parent_name ?? "", subcategory: into.name };
      for (const table of ["hd_tickets", "hd_request_types"]) {
        const r = await client.query(
          `UPDATE ${table} SET category = $3, subcategory = $4 WHERE lower(category) = lower($1) AND lower(subcategory) = lower($2)`,
          [fromParent, from.name, target.category, target.subcategory]
        );
        if (table === "hd_tickets") tickets = r.rowCount ?? 0;
        else requestTypes = r.rowCount ?? 0;
      }
      await rewriteCarriers(client, (c, s) => (pairKey(c, s) === pairKey(fromParent, from.name) ? target : null));
    }
    await client.query("DELETE FROM hd_categories WHERE id = $1", [from.id]);
    return { from: changeOf(from), into: changeOf(into), tickets, request_types: requestTypes, moved_subcategories: movedSubs };
  });
}
