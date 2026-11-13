// Helpdesk 1.20.6: managed categories and sub-categories, the pure half
// (no database, no server-only): the limits, the name rules, how a pair is
// written ("Hardware › Laptop") and how a pick is checked against the list.
// The server half is lib/helpdesk/categories; the desk's pickers and the
// settings page import this one.
//
// The rules in one place:
//   - A category has a name and any number of sub-categories. Two levels.
//   - Names are unique within their level whatever their case.
//   - A ticket's category, and its sub-category, must be on the list and not
//     archived when they are SET. A value a ticket already has is kept as it
//     is (an archived one stays on old tickets).
//   - A sub-category always belongs to the ticket's category: changing the
//     category without naming a sub-category clears it.

export const CATEGORY_LIMITS = {
  /** A name's length (the longest a 1.20.5 request type could hold). */
  name: 80,
  /** Categories an admin may add by hand. What is already in use on upgrade is taken in whatever its count. */
  categories: 200,
  /** Sub-categories under one category. */
  subcategories: 100,
  /** Names a refusal lists before "and N more". */
  listed: 30,
} as const;

/** Between a category and its sub-category wherever both are written as one value. */
export const CATEGORY_SEP = " › ";

/** The `code` on a 400 that refuses a category or sub-category that is not on the list. */
export const CATEGORY_NOT_LISTED = "category_not_listed";
export const SUBCATEGORY_NOT_LISTED = "subcategory_not_listed";

export interface HdSubcategory {
  id: number;
  name: string;
  archived: boolean;
}

export interface HdCategory {
  id: number;
  name: string;
  archived: boolean;
  subcategories: HdSubcategory[];
}

/** What uses a list entry (the settings page's facts line, and what stops a delete). */
export interface HdCategoryUse {
  tickets: number;
  request_types: number;
  automations: number;
}

export interface HdSubcategoryAdmin extends HdSubcategory {
  use: HdCategoryUse;
}

export interface HdCategoryAdmin extends Omit<HdCategory, "subcategories"> {
  /** Its own use and its sub-categories' together. */
  use: HdCategoryUse;
  subcategories: HdSubcategoryAdmin[];
}

/** The same name, whatever its case and outer spaces. */
export const categoryKey = (name: string) => name.trim().toLowerCase();

/** A name as it is stored: trimmed, inner runs of white space as one space. */
export function cleanCategoryName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** Why a name can't be used, or null. */
export function categoryNameProblem(name: string, what: "category" | "sub-category" = "category"): string | null {
  if (!name) return `Give the ${what} a name.`;
  if (name.length > CATEGORY_LIMITS.name) return `Keep the name under ${CATEGORY_LIMITS.name} characters.`;
  // The separator between a category and its sub-category stays unambiguous.
  if (name.includes("›")) return "A name can't contain ›.";
  return null;
}

/** "Hardware › Laptop", "Hardware", or "" (none). */
export function categoryLabel(category: string | null | undefined, subcategory?: string | null): string {
  const c = (category ?? "").trim();
  const s = (subcategory ?? "").trim();
  if (!c) return "";
  return s ? `${c}${CATEGORY_SEP}${s}` : c;
}

/** "Hardware › Laptop" → both; a value with no separator is a category alone. */
export function splitCategoryLabel(label: string): { category: string; subcategory: string } {
  const i = label.indexOf(CATEGORY_SEP);
  if (i < 0) return { category: label.trim(), subcategory: "" };
  return { category: label.slice(0, i).trim(), subcategory: label.slice(i + CATEGORY_SEP.length).trim() };
}

export function findCategory<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
  const k = categoryKey(name);
  return k ? list.find((c) => categoryKey(c.name) === k) : undefined;
}

/** "A, B, C and 4 more" for a refusal. */
export function listNames(names: string[]): string {
  if (names.length <= CATEGORY_LIMITS.listed) return names.join(", ");
  return `${names.slice(0, CATEGORY_LIMITS.listed).join(", ")} and ${names.length - CATEGORY_LIMITS.listed} more`;
}

export type CategoryPick =
  | { ok: true; category: string; subcategory: string }
  | { ok: false; error: string; code: typeof CATEGORY_NOT_LISTED | typeof SUBCATEGORY_NOT_LISTED; allowed: string[] };

/**
 * Check a category (and sub-category) someone wants to set against the list.
 * Answers the names as the list spells them, or the refusal: a sentence that
 * names the allowed values, its code and the values themselves.
 *
 * `current` is what the ticket (or request type, or rule) holds now: a value
 * it already has is always accepted as it is, so an archived category stays
 * where it was and a save that changes something else never trips on it.
 */
export function resolveCategoryPick(
  list: readonly HdCategory[],
  want: { category: string; subcategory?: string },
  current: { category?: string; subcategory?: string } = {}
): CategoryPick {
  const category = cleanCategoryName(want.category);
  const subcategory = cleanCategoryName(want.subcategory ?? "");
  const active = list.filter((c) => !c.archived);
  if (!category) {
    if (subcategory) {
      return { ok: false, code: SUBCATEGORY_NOT_LISTED, error: "A sub-category needs a category. Send the category too.", allowed: [] };
    }
    return { ok: true, category: "", subcategory: "" };
  }
  const sameCategory = !!current.category && categoryKey(current.category) === categoryKey(category);
  const listed = findCategory(list, category);
  // Not on the list, or archived: only as the value already held.
  if ((!listed || listed.archived) && !sameCategory) {
    const allowed = active.map((c) => c.name);
    const why = listed ? `"${listed.name}" is archived, so it can't be set on a ticket.` : `"${category.slice(0, CATEGORY_LIMITS.name)}" is not a category on the list.`;
    return {
      ok: false,
      code: CATEGORY_NOT_LISTED,
      error: allowed.length ? `${why} Categories: ${listNames(allowed)}.` : `${why} No categories are set up yet. An admin adds them in Desk settings, Categories.`,
      allowed,
    };
  }
  const name = listed?.name ?? current.category ?? category;
  if (!subcategory) return { ok: true, category: name, subcategory: "" };
  const sameSub = sameCategory && !!current.subcategory && categoryKey(current.subcategory) === categoryKey(subcategory);
  const sub = listed ? findCategory(listed.subcategories, subcategory) : undefined;
  if ((!sub || sub.archived) && !sameSub) {
    const allowed = (listed?.subcategories ?? []).filter((x) => !x.archived).map((x) => x.name);
    const why = sub ? `"${sub.name}" is archived, so it can't be set on a ticket.` : `"${subcategory.slice(0, CATEGORY_LIMITS.name)}" is not a sub-category of ${name}.`;
    return {
      ok: false,
      code: SUBCATEGORY_NOT_LISTED,
      error: allowed.length ? `${why} Sub-categories of ${name}: ${listNames(allowed)}.` : `${why} ${name} has no sub-categories.`,
      allowed,
    };
  }
  return { ok: true, category: name, subcategory: sub?.name ?? current.subcategory ?? subcategory };
}

/** "12 tickets · 2 request types · 1 automation", or "Not used yet". */
export function categoryUseLine(u: HdCategoryUse): string {
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
  if (u.tickets) parts.push(n(u.tickets, "ticket", "tickets"));
  if (u.request_types) parts.push(n(u.request_types, "request type", "request types"));
  if (u.automations) parts.push(n(u.automations, "automation", "automations"));
  return parts.join(" · ") || "Not used yet";
}

export const categoryInUse = (u: HdCategoryUse) => u.tickets + u.request_types + u.automations > 0;
