// Policy handbooks (1.18.0): the limits and sentences the server
// (lib/handbooks, which re-exports all of this) and the browser (the
// editor's working copy, the policy facts fields) share. Pure — no imports
// that reach the database — so a client component can import it and a
// form checks the very numbers the server enforces, never a copy of them.

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
/** The "Add policies" search answers at most this many rows. */
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
