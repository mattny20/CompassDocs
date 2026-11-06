// The handbook editor's working copy (1.18.0): the Details card's fields and
// the Contents card's sections and items, held on the client until Save. Pure
// functions only, so the moves the buttons make (up and down across a
// section edge, removing a section into its neighbour, ticking a candidate
// onto the end) are the same ones lib/handbooks makes on the server and can
// be read without a browser.
//
// lib/handbooks is server-only, so its types come in as `import type` (erased);
// the limits a form must check before a request are lib/handbook-shared's,
// the same constants the server enforces.

import type { FindMode, Handbook, HandbookAudienceMode, HandbookCandidate, HandbookItem } from "@/lib/handbooks";
import {
  HANDBOOK_FIRST_SECTION,
  HANDBOOK_GROUPS_REQUIRED,
  HANDBOOK_INTRO_MAX,
  HANDBOOK_ITEMS_MAX,
  HANDBOOK_SECTION_TITLE_MAX,
  HANDBOOK_SECTIONS_MAX,
  HANDBOOK_TITLE_MAX,
  handbookItemsLabel,
  handbookKind,
  handbookTypeCounts,
  kindNoun,
} from "@/lib/handbook-shared";
import type { HandbookTypeCounts } from "@/lib/handbook-shared";
import type { DocStatus, DocType } from "@/lib/types";

export const TITLE_MAX = HANDBOOK_TITLE_MAX;
export const INTRO_MAX = HANDBOOK_INTRO_MAX;
export const SECTION_TITLE_MAX = HANDBOOK_SECTION_TITLE_MAX;
export const ITEMS_MAX = HANDBOOK_ITEMS_MAX;
export const SECTIONS_MAX = HANDBOOK_SECTIONS_MAX;

/** The first section a handbook gets when its first policy is ticked (the server's first section too). */
export const FIRST_SECTION_TITLE = HANDBOOK_FIRST_SECTION;

export interface DraftItem {
  doc_id: number;
  title: string;
  type: DocType;
  doc_status: DocStatus;
  space_name: string;
  space_icon: string;
  version: number | null;
  version_at: string | null;
  /** Stored on the document; what the menu shows and Save writes. */
  find_mode: FindMode;
  /**
   * A locked placeholder (HandbookItem.restricted): a document from a space
   * this editor can't add from. Its title is HANDBOOK_RESTRICTED_ITEM; it can
   * be moved and removed, never opened or given another find mode.
   */
  restricted: boolean;
}

export interface DraftSection {
  /** Stable React key: `s{id}` for a saved section, `n{counter}` for a new one. */
  key: string;
  /** handbook_sections.id, absent until saved. */
  id?: number;
  title: string;
  items: DraftItem[];
}

export interface DraftDetails {
  title: string;
  /** "" = the whole workspace, else a space id as a string (the Select's value). */
  owner: string;
  introduction: string;
  audience: HandbookAudienceMode;
  group_ids: number[];
  confirm_whole: boolean;
  require_signature: boolean;
}

export function itemFromHandbook(i: HandbookItem): DraftItem {
  return {
    doc_id: i.doc_id,
    title: i.title,
    type: i.type,
    doc_status: i.doc_status,
    space_name: i.space_name,
    space_icon: i.space_icon,
    version: i.version,
    version_at: i.version_at,
    find_mode: i.find_mode,
    restricted: i.restricted,
  };
}

export function itemFromCandidate(c: HandbookCandidate): DraftItem {
  return {
    doc_id: c.id,
    title: c.title,
    type: c.type,
    doc_status: "published",
    space_name: c.space_name,
    space_icon: c.space_icon,
    version: c.version,
    version_at: c.updated_at,
    find_mode: "space",
    restricted: false,
  };
}

export function sectionsFromHandbook(h: Handbook | null): DraftSection[] {
  if (!h) return [];
  return [...h.sections]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ key: `s${s.id}`, id: s.id, title: s.title, items: s.items.map(itemFromHandbook) }));
}

export function detailsFromHandbook(h: Handbook | null, defaultOwner: string): DraftDetails {
  if (!h) {
    return {
      title: "",
      owner: defaultOwner,
      introduction: "",
      audience: "all",
      group_ids: [],
      confirm_whole: false,
      require_signature: false,
    };
  }
  return {
    title: h.title,
    owner: h.space_id === null ? "" : String(h.space_id),
    introduction: h.introduction,
    audience: h.audience,
    group_ids: h.groups.map((g) => g.id),
    confirm_whole: h.confirm_whole,
    require_signature: h.require_signature,
  };
}

/** Every item in reading order. */
export function allItems(sections: DraftSection[]): DraftItem[] {
  return sections.flatMap((s) => s.items);
}

export function itemCount(sections: DraftSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

export function hasDoc(sections: DraftSection[], docId: number): boolean {
  return sections.some((s) => s.items.some((i) => i.doc_id === docId));
}

let counter = 0;
/** A key for a section that has no id yet. */
export function newSectionKey(): string {
  counter += 1;
  return `n${counter}`;
}

/** Tick: onto the end of the last section (a first section is made when there is none). */
export function addItem(sections: DraftSection[], item: DraftItem): DraftSection[] {
  if (hasDoc(sections, item.doc_id)) return sections;
  if (sections.length === 0) return [{ key: newSectionKey(), title: FIRST_SECTION_TITLE, items: [item] }];
  const last = sections.length - 1;
  return sections.map((s, i) => (i === last ? { ...s, items: [...s.items, item] } : s));
}

export function removeItem(sections: DraftSection[], docId: number): DraftSection[] {
  return sections.map((s) => (s.items.some((i) => i.doc_id === docId) ? { ...s, items: s.items.filter((i) => i.doc_id !== docId) } : s));
}

/**
 * Up or down one place in the reading order. At a section's edge the item
 * crosses into the neighbouring section (to its end going up, its start going
 * down), as lib/handbooks moveHandbookItem does; at the handbook's ends it stays.
 */
export function moveItem(sections: DraftSection[], docId: number, direction: "up" | "down"): DraftSection[] {
  const si = sections.findIndex((s) => s.items.some((i) => i.doc_id === docId));
  if (si < 0) return sections;
  const items = sections[si].items;
  const ii = items.findIndex((i) => i.doc_id === docId);
  const item = items[ii];
  const next = sections.map((s) => ({ ...s, items: [...s.items] }));
  if (direction === "up") {
    if (ii > 0) {
      next[si].items.splice(ii, 1);
      next[si].items.splice(ii - 1, 0, item);
    } else if (si > 0) {
      next[si].items.splice(ii, 1);
      next[si - 1].items.push(item);
    } else return sections;
  } else {
    if (ii < items.length - 1) {
      next[si].items.splice(ii, 1);
      next[si].items.splice(ii + 1, 0, item);
    } else if (si < sections.length - 1) {
      next[si].items.splice(ii, 1);
      next[si + 1].items.unshift(item);
    } else return sections;
  }
  return next;
}

/** Can this item move that way at all? Not past the handbook's first or last section's edge (an empty neighbour still takes it). */
export function canMove(sections: DraftSection[], docId: number, direction: "up" | "down"): boolean {
  const si = sections.findIndex((s) => s.items.some((i) => i.doc_id === docId));
  if (si < 0) return false;
  const ii = sections[si].items.findIndex((i) => i.doc_id === docId);
  return direction === "up" ? ii > 0 || si > 0 : ii < sections[si].items.length - 1 || si < sections.length - 1;
}

export function addSection(sections: DraftSection[], title: string): DraftSection[] {
  return [...sections, { key: newSectionKey(), title: title.trim(), items: [] }];
}

export function renameSection(sections: DraftSection[], key: string, title: string): DraftSection[] {
  return sections.map((s) => (s.key === key ? { ...s, title: title.trim() } : s));
}

/** Removes a section; its items go to the end of the previous section (the next one's start for the first). The last section stays. */
export function removeSection(sections: DraftSection[], key: string): DraftSection[] {
  if (sections.length <= 1) return sections;
  const i = sections.findIndex((s) => s.key === key);
  if (i < 0) return sections;
  const moved = sections[i].items;
  const rest = sections.filter((_, j) => j !== i).map((s) => ({ ...s, items: [...s.items] }));
  if (i > 0) rest[i - 1].items.push(...moved);
  else rest[0].items.unshift(...moved);
  return rest;
}

export function setFindMode(sections: DraftSection[], docId: number, mode: FindMode): DraftSection[] {
  return sections.map((s) => ({ ...s, items: s.items.map((i) => (i.doc_id === docId ? { ...i, find_mode: mode } : i)) }));
}

/** The body of PUT …/contents. */
export function contentsPayload(sections: DraftSection[]): { sections: { id?: number; title: string; doc_ids: number[] }[] } {
  return {
    sections: sections.map((s) => ({ ...(s.id ? { id: s.id } : {}), title: s.title, doc_ids: s.items.map((i) => i.doc_id) })),
  };
}

/**
 * After a contents save: the server's section ids onto the page's sections.
 * The PUT keeps the sections in the order and number it was sent, so they
 * pair by position; keys stay as they are, so no row remounts. Anything
 * else (a list that no longer lines up) is left alone.
 */
export function withSectionIds(sections: DraftSection[], saved: Handbook): DraftSection[] {
  const server = [...saved.sections].sort((a, b) => a.position - b.position);
  if (server.length !== sections.length) return sections;
  return sections.map((s, i) => (s.id === server[i].id ? s : { ...s, id: server[i].id }));
}

/** The body of POST /api/handbooks and PATCH …/[id]. */
export function detailsPayload(d: DraftDetails) {
  return {
    title: d.title.trim(),
    space_id: d.owner === "" ? null : Number(d.owner),
    introduction: d.introduction,
    audience: d.audience,
    group_ids: d.audience === "groups" ? d.group_ids : [],
    confirm_whole: d.confirm_whole,
    // A signature only means something on a whole-handbook confirmation.
    require_signature: d.confirm_whole && d.require_signature,
  };
}

/** Documents whose "Where people find it" changed against the saved handbook. */
export function findModeChanges(saved: Handbook | null, sections: DraftSection[]): { doc_id: number; mode: FindMode }[] {
  const before = new Map<number, FindMode>();
  for (const s of saved?.sections ?? []) for (const i of s.items) before.set(i.doc_id, i.find_mode);
  return allItems(sections)
    .filter((i) => (before.get(i.doc_id) ?? "space") !== i.find_mode)
    .map((i) => ({ doc_id: i.doc_id, mode: i.find_mode }));
}

/** The first problem with the Details card, keyed by field. */
export function detailsErrors(d: DraftDetails): { title?: string; groups?: string; introduction?: string } {
  const out: { title?: string; groups?: string; introduction?: string } = {};
  const t = d.title.trim();
  if (!t) out.title = "Give the handbook a title.";
  else if (t.length > TITLE_MAX) out.title = `Up to ${TITLE_MAX} characters.`;
  if (d.introduction.length > INTRO_MAX) out.introduction = `Up to ${INTRO_MAX.toLocaleString("en")} characters.`;
  if (d.audience === "groups" && d.group_ids.length === 0) out.groups = HANDBOOK_GROUPS_REQUIRED;
  return out;
}

/** "8 policies", "1 policy". */
export function policies(n: number): string {
  return `${n} ${n === 1 ? "policy" : "policies"}`;
}

/** What the working copy holds, by kind (a locked placeholder is a plain document). */
export function draftTypeCounts(sections: DraftSection[]): HandbookTypeCounts {
  return handbookTypeCounts(allItems(sections));
}

/** "8 policies", "2 SOPs", "3 policies and 2 SOPs": the Contents card's count (1.18.2). */
export function itemsLabel(sections: DraftSection[]): string {
  return handbookItemsLabel(draftTypeCounts(sections));
}

/**
 * The plural noun the editor's sentences use for what the handbook holds:
 * "policies" while it is policies only (or empty), "SOPs" for SOPs only,
 * else "documents".
 */
export function itemsNoun(sections: DraftSection[]): string {
  return kindNoun(handbookKind(draftTypeCounts(sections)), 2);
}

/** The Add documents panel's empty result, per type filter (1.18.2): what was searched for, and where else to look. */
export function candidatesEmptyText(type: "policy" | "sop" | "all", searched: boolean): string {
  const what = type === "policy" ? "policies" : type === "sop" ? "SOPs" : "documents";
  if (searched) return `No published ${what} match your search.`;
  if (type === "policy") return "No published policies here. Try SOPs or All types.";
  if (type === "sop") return "No published SOPs here. Try Policies or All types.";
  return "No published documents here.";
}
