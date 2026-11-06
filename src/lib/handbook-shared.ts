// Policy handbooks (1.18.0): the limits and sentences the server
// (lib/handbooks, which re-exports all of this) and the browser (the
// editor's working copy, the policy facts fields) share. Pure — no imports
// that reach the database — so a client component can import it and a
// form checks the very numbers the server enforces, never a copy of them.

import type { DocType } from "./types";

// --- What a handbook holds (1.18.2) -------------------------------------------------
// A handbook holds policies, SOPs or both (and, through "All types", any
// other published document). Every count and position a person reads goes
// through these, so the list, the reader, the confirm page, the printed copy
// and the editor say the same thing. A handbook of policies only (or an empty
// one) keeps the 1.18.0 words exactly: "8 policies", "Policy 3 of 8".

/** How many of each kind a handbook (or a part of it) holds. `other`: any type but policy and SOP. */
export interface HandbookTypeCounts {
  policy: number;
  sop: number;
  other: number;
}

/** The kind a set of items is named by: one type throughout, else "document". */
export type HandbookNounKind = "policy" | "sop" | "document";

/** Count the kinds; a locked placeholder (`restricted`) counts as a plain document, so its type never shows. */
export function handbookTypeCounts(items: readonly ({ type: DocType; restricted?: boolean } | DocType)[]): HandbookTypeCounts {
  const out: HandbookTypeCounts = { policy: 0, sop: 0, other: 0 };
  for (const it of items) {
    const type = typeof it === "string" ? it : it.restricted ? "knowledge" : it.type;
    if (type === "policy") out.policy++;
    else if (type === "sop") out.sop++;
    else out.other++;
  }
  return out;
}

const totalOf = (c: HandbookTypeCounts) => c.policy + c.sop + c.other;

/** One document's own noun: policy, SOP, else document. */
export function itemKind(type: DocType): HandbookNounKind {
  return type === "policy" ? "policy" : type === "sop" ? "sop" : "document";
}

/** What a set is called: policies when it is all policies (or empty), SOPs when all SOPs, else documents. */
export function handbookKind(c: HandbookTypeCounts): HandbookNounKind {
  if (c.sop === 0 && c.other === 0) return "policy";
  if (c.policy === 0 && c.other === 0) return "sop";
  return "document";
}

const NOUNS: Record<HandbookNounKind, { one: string; many: string }> = {
  policy: { one: "policy", many: "policies" },
  sop: { one: "SOP", many: "SOPs" },
  document: { one: "document", many: "documents" },
};

/** "policy" / "policies", "SOP" / "SOPs", "document" / "documents". */
export function kindNoun(kind: HandbookNounKind, n = 1): string {
  return n === 1 ? NOUNS[kind].one : NOUNS[kind].many;
}

/** The same, first letter capitalised ("Policy", "SOPs", "Documents"). */
export function kindNounTitle(kind: HandbookNounKind, n = 1): string {
  const w = kindNoun(kind, n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function andList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The count a person reads: "8 policies", "1 SOP", "3 policies and 2 SOPs",
 * "3 policies, 2 SOPs and 1 other document"; "4 documents" when nothing is a
 * policy or an SOP; "0 policies" for an empty handbook. Other types beside
 * policies or SOPs are "other documents", so the breakdown never reads as if
 * the policies and SOPs were not documents too.
 */
export function handbookItemsLabel(c: HandbookTypeCounts): string {
  const kind = handbookKind(c);
  if (kind !== "document" || (c.policy === 0 && c.sop === 0)) {
    const n = totalOf(c);
    return `${n} ${kindNoun(kind, n)}`;
  }
  const parts = [
    c.policy > 0 ? `${c.policy} ${kindNoun("policy", c.policy)}` : "",
    c.sop > 0 ? `${c.sop} ${kindNoun("sop", c.sop)}` : "",
    c.other > 0 ? `${c.other} other ${kindNoun("document", c.other)}` : "",
  ];
  return andList(parts.filter(Boolean));
}

/**
 * The reader's "Next …" control (its aria-label): named by what the
 * handbook holds, not by the document on screen, since the next one may
 * be of another kind: "Next policy", "Next SOP", "Next document".
 */
export function nextItemLabel(handbook: HandbookNounKind): string {
  return `Next ${kindNoun(handbook)}`;
}

/** Where an item sits: "Policy 3 of 8", "SOP 3 of 8", "Document 3 of 8" in a mixed handbook. */
export function handbookPositionLabel(c: HandbookTypeCounts, k: number, total = totalOf(c)): string {
  return `${kindNounTitle(handbookKind(c))} ${k} of ${total}`;
}

// --- Limits ----------------------------------------------------------------------

export const HANDBOOK_TITLE_MAX = 160;
export const HANDBOOK_INTRO_MAX = 20000;
export const HANDBOOK_SECTION_TITLE_MAX = 120;
export const HANDBOOK_SECTIONS_MAX = 50;
export const HANDBOOK_ITEMS_MAX = 200;
export const HANDBOOK_GROUPS_MAX = 200;
export const SUMMARY_POINTS_MAX = 5;
export const SUMMARY_POINT_MAX = 200;
export const APPLIES_TO_MAX = 200;
/** The "Add documents" search answers at most this many rows. */
export const HANDBOOK_CANDIDATES_MAX = 100;

// --- Names ----------------------------------------------------------------------

export const HANDBOOK_NOT_FOUND = "Not found.";
export const HANDBOOK_WORKSPACE_LABEL = "Whole workspace";
/** The first section a new handbook starts with (renamable). */
export const HANDBOOK_FIRST_SECTION = "Policies";
export const HANDBOOK_NEW_SECTION = "New section";

// --- Sentences ------------------------------------------------------------------

export const HANDBOOK_TITLE_REQUIRED = `Enter a title of up to ${HANDBOOK_TITLE_MAX} characters.`;
export const HANDBOOK_INTRO_TOO_LONG = `Keep the introduction under ${HANDBOOK_INTRO_MAX.toLocaleString("en-US")} characters.`;
export const HANDBOOK_OWNER_INVALID = "'space_id' must be a space id, or null for the whole workspace.";
export const HANDBOOK_OWNER_DENIED = "You can't own a handbook there.";
export const HANDBOOK_SPACE_MISSING = "That space doesn't exist.";
export const HANDBOOK_AUDIENCE_INVALID = "'audience' must be 'all' or 'groups'.";
export const HANDBOOK_GROUPS_INVALID = `'group_ids' must be up to ${HANDBOOK_GROUPS_MAX} group ids.`;
export const HANDBOOK_GROUPS_REQUIRED = "Choose at least one group, or let everyone read it.";
export const HANDBOOK_NOTHING_TO_CHANGE = "Nothing to change.";
export const HANDBOOK_SECTION_TITLE_REQUIRED = `Name the section in up to ${HANDBOOK_SECTION_TITLE_MAX} characters.`;
export const HANDBOOK_SECTIONS_RANGE = `A handbook has 1 to ${HANDBOOK_SECTIONS_MAX} sections.`;
export const HANDBOOK_ITEMS_RANGE = `A handbook holds up to ${HANDBOOK_ITEMS_MAX} documents.`;
export const HANDBOOK_DOC_IDS_INVALID = "doc_ids must be positive integers, each document once.";
export const HANDBOOK_DOCS_INVALID = "Every item must be a published document you may add.";
export const HANDBOOK_SECTION_NOT_FOUND = "That section isn't in this handbook.";
export const HANDBOOK_ITEM_NOT_FOUND = "That document isn't in this handbook.";
export const HANDBOOK_LAST_SECTION = "A handbook keeps at least one section.";
export const HANDBOOK_EMPTY_PUBLISH = "Add at least one published document before publishing.";
export const HANDBOOK_FIND_MODE_INVALID = "'find_mode' must be 'space' or 'handbook_only'.";
export const HANDBOOK_FIND_MODE_DENIED = "You can't change where people find documents in that space.";
export const HANDBOOK_FIND_MODE_TWICE = "Give each document one find mode, not two.";
export const HANDBOOK_FIND_MODES_RANGE = `Set where people find up to ${HANDBOOK_ITEMS_MAX} documents at a time.`;
export const SUMMARY_POINTS_INVALID = `Send up to ${SUMMARY_POINTS_MAX} summary points of up to ${SUMMARY_POINT_MAX} characters each.`;
export const APPLIES_TO_INVALID = `Keep "Applies to" under ${APPLIES_TO_MAX} characters.`;
/** 409 on a save whose `if_updated_at` no longer matches: another editor saved in between. */
export const HANDBOOK_CHANGED_ELSEWHERE = "This handbook was changed by someone else. Reload to see their changes.";
export const HANDBOOK_IF_UPDATED_AT_INVALID = "'if_updated_at' must be the handbook's updated_at as last loaded.";
/**
 * 403 on publishing, or on changing who reads it or who owns it, when the
 * handbook holds documents from spaces the editor could not add from:
 * widening who reads them is for someone who may add from those spaces.
 */
export const HANDBOOK_FOREIGN_CONTENTS =
  "This handbook holds documents from spaces you can't add from, so you can't publish it or change who reads it or who owns it. Ask someone who can add from those spaces.";
/** The placeholder title of an item from a space the editor can't add from (the editor's view; never its real title). */
export const HANDBOOK_RESTRICTED_ITEM = "A document you can't open";
