// Policy handbooks (1.18.0): a named, ordered bundle of published documents
// from any spaces, grouped into sections, with an introduction, that people
// read as one, print as a paper copy and (policy_ack) confirm as a whole.
//
// This module is the domain layer: who may build and who may read a
// handbook, the request parsing, and the operations the routes and pages
// call, each audited here. The SQL lives in lib/db.ts ("Handbooks 1.18.0");
// nothing here holds a pool client.
//
// Who builds: `handbook.manage` (space-scoped). Held globally it owns
// workspace handbooks and handbooks in any space; assigned on a space it
// makes that person the space's handbook admin (there is no other
// space-admin concept: docs/rbac/permission-catalog.md §3.31). A space you
// cannot read is never one you manage. Legacy break-glass: admins only.
//
// Who reads: a published handbook's audience — everyone (workspace), the
// people who can read the owning space (space handbook), or the chosen
// groups (of a space handbook: only those of them who can read the space)
// — and its editors, whatever its status. Reading a handbook opens its
// documents THROUGH the handbook (getHandbookPolicy renders them; the
// /doc/{id} page keeps its own space checks, unchanged).
//
// Editing rights are not reading rights: someone who reaches a handbook
// only as its editor (not as a reader of it, published) sees inside it the
// documents of the spaces they could add from (addableSpaces), and the rest
// as a placeholder in the editor and not at all in the reader and the
// printed copy. Nor do they let anyone widen who reads documents they could
// not have added: publishing, and changing the audience or the owner, are
// refused while the handbook holds a document from such a space.
//
// Server-only.

import "server-only";
import { createHash } from "node:crypto";
import {
  addableHandbookDocIds,
  createHandbookRow,
  deleteHandbookRow,
  documentFindModeRow,
  getDocument,
  getHandbookRow,
  getSpaceById,
  getUserById,
  groupIdsOfUser,
  handbookCandidateRows,
  handbookItemSpaceIds,
  handbookProgressCounts,
  handbooksForDocumentRows,
  insertHandbookConfirmation,
  latestHandbookConfirmation,
  listGroupNames,
  listHandbookItemRows,
  listHandbookRows,
  listHandbookSectionRows,
  listSpaces,
  mutateHandbookContents,
  publishedHandbookAdmits,
  publishedHandbookRequiresSignature,
  reconcilePoliciesForHandbook,
  documentFindModeRows,
  setDocumentFindModes,
  setHandbookStatusRow,
  updateHandbookRow,
} from "./db";
import type { HandbookContentsDraft, HandbookItemRow, HandbookRow, HandbookSectionRow } from "./db";
import { scopeAllows, spaceScopeFor, userHolds } from "./access";
import type { SpaceScope } from "./access";
import { grantsFor, holds, spacesWith, legacyAuthzEnforcement } from "./authz";
import type { Grants } from "./authz";
import { actorFrom, audit, ipFrom } from "./audit";
import { featureEnabled } from "./ee";
import type { DocStatus, DocType, DocumentWithSpace, Role } from "./types";

// --- Types ---------------------------------------------------------------------

export type HandbookStatus = "draft" | "published";
/**
 * Who reads a handbook. 'all' = everyone in the workspace (a workspace
 * handbook) or everyone who can read the space (a space handbook);
 * 'groups' = members of the chosen groups only.
 */
export type HandbookAudienceMode = "all" | "groups";
/** documents.find_mode. 'handbook_only' hides the document from ordinary readers outside its handbooks. */
export type FindMode = "space" | "handbook_only";

/** The caller, as every check takes it (a SessionUser fits). */
export type HandbookUser = { id: number; role: Role; name?: string; username?: string };

/** One policy in a handbook, as the editor, reader and print pages list it. */
export interface HandbookItem {
  /** handbook_items.id */
  id: number;
  section_id: number;
  /** The document. */
  doc_id: number;
  /** 1-based number across the whole handbook as shown ("Policy k of N"). */
  number: number;
  title: string;
  type: DocType;
  /** The document's own status. Readers only ever get 'published' items; the editor also sees drafts. */
  doc_status: DocStatus;
  space_id: number;
  space_name: string;
  space_slug: string;
  space_icon: string;
  /** The latest version's ordinal ("v4"), the text the reader is shown; null before the first version. */
  version: number | null;
  /**
   * doc_versions.id of what a whole-handbook confirmation is of (the
   * fingerprint): the confirmation marker's version (ack_version_id) when
   * the policy asks for confirmation, else the latest version.
   */
  version_id: number | null;
  /** When the latest version was written (the "Jan 2026" in the editor row). */
  version_at: string | null;
  updated_at: string;
  /** Stored on the document. */
  find_mode: FindMode;
  /** After the no-orphans rule: handbook_only only while the doc is in at least one PUBLISHED handbook. */
  effective_find_mode: FindMode;
  ack_required: number;
  ack_signature: number;
  summary_points: string[];
  applies_to: string;
  /**
   * The policy page's Owner, Approved by and Effective facts — one rule
   * (lib/db listHandbookItemRows), so the reader and the printed copy say
   * the same: the policy's own owner, else its space's Policy owner, else
   * whoever switched the requirement on (the first that is an active
   * account, in the compliance portal's order: one shared SQL fragment);
   * else the publisher of the latest version, else that version's author,
   * else the byline.
   */
  owner_name: string;
  /** Who approved the latest version; '' when it went live without a review. */
  approver_name: string;
  /** When the latest version was written (the Effective date); null before the first version. */
  effective_at: string | null;
  /**
   * A placeholder: the document is in a space this editor can't add from
   * and they don't read the handbook as its audience, so only its id, space
   * id and find mode are real (the title is HANDBOOK_RESTRICTED_ITEM, the
   * type RESTRICTED_ITEM_TYPE, the facts empty). Only ever in the editor's view; the reader's view and
   * the printed copy leave such a document out.
   */
  restricted: boolean;
}

export interface HandbookSection {
  id: number;
  /** 1-based section number as shown. */
  number: number;
  title: string;
  position: number;
  items: HandbookItem[];
}

/** One row of the list page. */
export interface HandbookSummary {
  id: number;
  title: string;
  status: HandbookStatus;
  /** null = a workspace handbook. */
  space_id: number | null;
  space_name: string | null;
  space_slug: string | null;
  space_icon: string | null;
  /** "Whole workspace" or the space's name. */
  owner_label: string;
  audience: HandbookAudienceMode;
  /** Items as the caller sees them (editors: every live item including drafts; readers: published ones). */
  item_count: number;
  /**
   * The same items by kind (1.18.2), for "3 policies and 2 SOPs"
   * (handbookItemsLabel); a locked placeholder counts as `other`.
   */
  item_types: HandbookTypeCounts;
  section_count: number;
  /** "Ask readers to confirm the whole handbook". */
  confirm_whole: boolean;
  /** "Require a typed signature" (on top of the policies' own). */
  require_signature: boolean;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  /** Whether the caller may edit it. */
  can_edit: boolean;
  /**
   * Whole-handbook confirmation progress: active people in the audience,
   * and how many hold a handbook confirmation of the current contents
   * (fingerprint). null when confirm_whole is off, the handbook is a
   * draft, policy_ack is not licensed, or the caller is neither its editor
   * nor holds compliance.program_read (a reader is never shown everyone's
   * standing).
   */
  progress: { audience: number; confirmed: number; pct: number } | null;
  /**
   * Only when asked (listHandbooks' `readableDocIds`, the connector's
   * list_handbooks): the documents the caller's reader view of this
   * handbook holds, as getHandbook would list them, from the rows already
   * loaded for the list. Absent otherwise.
   */
  readable_doc_ids?: number[];
}

/** Everything a page needs about one handbook. */
export interface Handbook extends HandbookSummary {
  introduction: string;
  /** The chosen groups (audience 'groups'); [] for 'all'. */
  groups: { id: number; name: string }[];
  sections: HandbookSection[];
  created_by: number | null;
  created_by_name: string;
  updated_by_name: string;
  /** handbookFingerprint() of the published items in reading order — what a whole-handbook confirmation is of. */
  fingerprint: string;
}

/** What POST /api/handbooks and createHandbook take. */
export interface HandbookInput {
  title: string;
  /** null = workspace handbook. */
  space_id: number | null;
  introduction: string;
  audience: HandbookAudienceMode;
  group_ids: number[];
  confirm_whole: boolean;
  require_signature: boolean;
}
/** PATCH /api/handbooks/[id]: any subset, at least one. Status changes go through publishHandbook. */
export type HandbookPatch = Partial<HandbookInput>;

/** PUT /api/handbooks/[id]/contents: the whole Contents card, in order. A section without an id is new. */
export interface HandbookContentsInput {
  sections: { id?: number; title: string; doc_ids: number[] }[];
}

/** A row of the editor's "Add documents" panel. */
export interface HandbookCandidate {
  id: number;
  title: string;
  type: DocType;
  space_id: number;
  space_name: string;
  space_icon: string;
  version: number | null;
  updated_at: string;
  /** Already in this handbook. */
  in_handbook: boolean;
}

/** The editor's pickers. */
export interface HandbookOptions {
  /** May create a workspace handbook (handbook.manage held globally). */
  can_create_workspace: boolean;
  /** Spaces the caller may own a handbook in (and add documents from, for a space handbook). */
  spaces: { id: number; name: string; icon: string; slug: string }[];
  /** Every space the caller can see (the "All spaces" filter of a workspace handbook's search). */
  visible_spaces: { id: number; name: string; icon: string; slug: string }[];
  groups: { id: number; name: string }[];
  /** policy_ack licensed: show the confirm switches and progress. */
  policy_ack: boolean;
}

/** A document opened through a handbook (the reader renders this, never /doc/{id}). */
export interface HandbookPolicy {
  handbook: Handbook;
  item: HandbookItem;
  section: HandbookSection;
  document: DocumentWithSpace;
  /** The neighbours in reading order, null at either end. */
  next: HandbookItem | null;
  prev: HandbookItem | null;
}

/** A refusal; the routes answer `status` with `{ error: message }`. */
export class HandbookError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400
  ) {
    super(message);
    this.name = "HandbookError";
  }
}

// --- Limits and sentences ------------------------------------------------------------
// In lib/handbook-shared (client-safe, so the editor checks the same numbers);
// re-exported so the routes and tests keep importing them from here.

export * from "./handbook-shared";
import {
  APPLIES_TO_INVALID,
  APPLIES_TO_MAX,
  HANDBOOK_CANDIDATES_MAX,
  HANDBOOK_DOC_IDS_INVALID,
  HANDBOOK_DOCS_INVALID,
  HANDBOOK_EMPTY_PUBLISH,
  HANDBOOK_FIND_MODE_DENIED,
  HANDBOOK_FIND_MODE_TWICE,
  HANDBOOK_FIND_MODES_RANGE,
  HANDBOOK_FIRST_SECTION,
  HANDBOOK_GROUPS_INVALID,
  HANDBOOK_GROUPS_MAX,
  HANDBOOK_GROUPS_REQUIRED,
  HANDBOOK_ITEM_NOT_FOUND,
  HANDBOOK_ITEMS_MAX,
  HANDBOOK_ITEMS_RANGE,
  HANDBOOK_INTRO_MAX,
  HANDBOOK_INTRO_TOO_LONG,
  HANDBOOK_AUDIENCE_INVALID,
  HANDBOOK_CHANGED_ELSEWHERE,
  HANDBOOK_FOREIGN_CONTENTS,
  HANDBOOK_IF_UPDATED_AT_INVALID,
  HANDBOOK_LAST_SECTION,
  HANDBOOK_NEW_SECTION,
  HANDBOOK_NOT_FOUND,
  HANDBOOK_NOTHING_TO_CHANGE,
  HANDBOOK_OWNER_DENIED,
  HANDBOOK_OWNER_INVALID,
  HANDBOOK_SECTION_NOT_FOUND,
  HANDBOOK_SECTION_TITLE_MAX,
  HANDBOOK_SECTION_TITLE_REQUIRED,
  HANDBOOK_SECTIONS_MAX,
  HANDBOOK_SECTIONS_RANGE,
  HANDBOOK_RESTRICTED_ITEM,
  HANDBOOK_SPACE_MISSING,
  HANDBOOK_TITLE_MAX,
  HANDBOOK_TITLE_REQUIRED,
  HANDBOOK_WORKSPACE_LABEL,
  SUMMARY_POINT_MAX,
  SUMMARY_POINTS_INVALID,
  SUMMARY_POINTS_MAX,
  handbookTypeCounts,
} from "./handbook-shared";
import type { HandbookTypeCounts } from "./handbook-shared";

// --- The caller, resolved once ---------------------------------------------------------

interface Viewer {
  user: HandbookUser;
  legacy: boolean;
  grants: Grants | null;
  scope: SpaceScope;
  groups: Set<number>;
}

async function viewerFor(user: HandbookUser): Promise<Viewer> {
  const legacy = legacyAuthzEnforcement();
  const [grants, scope, groups] = await Promise.all([
    legacy ? Promise.resolve(null) : grantsFor(user.id),
    spaceScopeFor(user),
    groupIdsOfUser(user.id),
  ]);
  return { user, legacy, grants, scope, groups: new Set(groups) };
}

/** May the viewer own a handbook here (null = the workspace)? */
function managesOwner(v: Viewer, spaceId: number | null): boolean {
  if (v.legacy) return v.user.role === "admin";
  if (!v.grants) return false;
  if (spaceId === null) return holds(v.grants, "handbook.manage");
  return holds(v.grants, "handbook.manage", spaceId) && scopeAllows(v.scope, spaceId);
}

/** The spaces the viewer manages handbooks in: "all" or visible ids. */
function managedSpaces(v: Viewer): "all" | number[] {
  if (v.legacy) return v.user.role === "admin" ? v.scope : [];
  if (!v.grants) return [];
  const held = spacesWith(v.grants, "handbook.manage");
  if (held === "all") return v.scope === "all" ? "all" : [...v.scope];
  return held.filter((id) => scopeAllows(v.scope, id));
}

/** The spaces documents may be added from: any visible space (workspace handbook) or the managed ones. */
function addableSpaces(v: Viewer, ownerSpaceId: number | null): "all" | number[] {
  if (ownerSpaceId === null) return v.scope === "all" ? "all" : [...v.scope];
  return managedSpaces(v);
}

/**
 * In the audience (lib/db handbookAudienceAdmitsSql is the SQL twin): a
 * space handbook reaches only people who can read its space, and 'groups'
 * narrows within them; a workspace handbook reaches everyone, or the groups.
 */
function inAudience(v: Viewer, row: Pick<HandbookRow, "audience" | "group_ids" | "space_id">): boolean {
  if (row.space_id !== null && !scopeAllows(v.scope, row.space_id)) return false;
  if (row.audience === "groups") return row.group_ids.some((g) => v.groups.has(g));
  return true;
}

/**
 * The spaces whose documents this viewer sees inside this handbook: "all"
 * for a reader of it (published, in the audience: the handbook opens its
 * documents), else — someone who reaches it only as its editor — the spaces
 * they could add from. Editing rights never read further than that.
 */
function openableSpaces(v: Viewer, row: HandbookRow): "all" | number[] {
  if (row.status === "published" && inAudience(v, row)) return "all";
  return addableSpaces(v, row.space_id);
}

/**
 * Refuses (403) when the handbook holds a document from a space the viewer
 * could not add from to a handbook owned by `ownerSpaceId`: publishing it,
 * or changing who reads or owns it, would widen who reads that document on
 * the authority of someone who could never have put it there.
 */
async function assertOwnContents(v: Viewer, handbookId: number, ownerSpaceId: number | null): Promise<void> {
  const addable = addableSpaces(v, ownerSpaceId);
  if (addable === "all") return;
  const spaces = await handbookItemSpaceIds(handbookId);
  if (spaces.some((s) => !addable.includes(s))) throw new HandbookError(HANDBOOK_FOREIGN_CONTENTS, 403);
}

function readsRow(v: Viewer, row: HandbookRow): boolean {
  if (managesOwner(v, row.space_id)) return true;
  return row.status === "published" && inAudience(v, row);
}

function seesProgress(v: Viewer, canEdit: boolean): boolean {
  if (canEdit) return true;
  if (v.legacy) return v.user.role === "admin";
  return v.grants !== null && holds(v.grants, "compliance.program_read");
}

function actorName(user: HandbookUser): string {
  return user.name || user.username || `user #${user.id}`;
}

/**
 * Where a write came from, for its audit row, when there is no Request to
 * read it from: the Claude connector (1.18.2) passes the caller's address
 * and `via: "mcp"`, as its own document rows say. A route passes its
 * Request instead and its rows are unchanged.
 */
export interface HandbookWriteContext {
  via?: "mcp";
  ip?: string | null;
}

function auditIp(req: Request | undefined, ctx: HandbookWriteContext | undefined): string | null {
  return req ? ipFrom(req) : (ctx?.ip ?? null);
}

function viaDetails(ctx: HandbookWriteContext | undefined): { via?: "mcp" } {
  return ctx?.via ? { via: ctx.via } : {};
}

function auditActor(user: HandbookUser) {
  return actorFrom({ id: user.id, role: user.role, name: user.name ?? "", username: user.username ?? "" });
}

// --- Assembling a handbook ----------------------------------------------------------------

/** sha256 of the ordered "doc_id:version_id" list (lib/handbook-confirm's itemsFingerprint is the same formula). */
export function handbookFingerprint(items: { doc_id: number; version_id: number | null }[]): string {
  return createHash("sha256")
    .update(items.map((i) => `${i.doc_id}:${i.version_id ?? ""}`).join("\n"))
    .digest("hex");
}

/** The type a placeholder carries (HandbookItem.restricted): neutral, never the document's own. */
export const RESTRICTED_ITEM_TYPE: DocType = "knowledge";

function toItem(r: HandbookItemRow, number: number, restricted = false): HandbookItem {
  const item: HandbookItem = {
    id: r.id,
    section_id: r.section_id,
    doc_id: r.doc_id,
    number,
    title: r.title,
    type: r.type,
    doc_status: r.doc_status,
    space_id: r.space_id,
    space_name: r.space_name,
    space_slug: r.space_slug,
    space_icon: r.space_icon,
    version: r.version,
    version_id: r.version_id,
    version_at: r.version_at,
    updated_at: r.updated_at,
    find_mode: r.find_mode === "handbook_only" ? "handbook_only" : "space",
    effective_find_mode: r.effective_handbook_only ? "handbook_only" : "space",
    ack_required: r.ack_required,
    ack_signature: r.ack_signature,
    summary_points: r.summary_points ?? [],
    applies_to: r.applies_to ?? "",
    owner_name: r.owner_name ?? "",
    approver_name: r.approver_name ?? "",
    effective_at: r.effective_at,
    restricted: false,
  };
  if (!restricted) return item;
  // Nothing of the document but what the editor needs to keep, move or
  // remove the item. Its type too is a neutral one (a plain document, as
  // handbookTypeCounts counts a placeholder), so the JSON never says
  // whether a locked document is a policy or an SOP.
  return {
    ...item,
    title: HANDBOOK_RESTRICTED_ITEM,
    type: RESTRICTED_ITEM_TYPE,
    space_name: "",
    space_slug: "",
    space_icon: "",
    version: null,
    version_at: null,
    summary_points: [],
    applies_to: "",
    owner_name: "",
    approver_name: "",
    effective_at: null,
    restricted: true,
  };
}

function assemble(
  row: HandbookRow,
  sectionRows: HandbookSectionRow[],
  itemRows: HandbookItemRow[],
  opts: { forEdit: boolean; canEdit: boolean; groupNames: Map<number, string>; openable: "all" | number[] }
): Omit<Handbook, "progress"> {
  const opens = (r: HandbookItemRow) => opts.openable === "all" || opts.openable.includes(r.space_id);
  // The reader's view (and the printed copy) leaves out what the viewer may
  // not open; the editor's view keeps it as a placeholder, so a save of the
  // Contents card holds it in place.
  const shownRows = opts.forEdit ? itemRows : itemRows.filter((r) => r.live && opens(r));
  const sections: HandbookSection[] = [];
  let n = 0;
  for (const s of sectionRows) {
    const items = shownRows.filter((r) => r.section_id === s.id).map((r) => toItem(r, ++n, !opens(r)));
    if (!opts.forEdit && items.length === 0) continue;
    sections.push({ id: s.id, number: sections.length + 1, title: s.title, position: s.position, items });
  }
  const live = itemRows.filter((r) => r.live);
  return {
    id: row.id,
    title: row.title,
    status: row.status === "published" ? "published" : "draft",
    space_id: row.space_id,
    space_name: row.space_name,
    space_slug: row.space_slug,
    space_icon: row.space_icon,
    owner_label: row.space_id === null ? HANDBOOK_WORKSPACE_LABEL : (row.space_name ?? ""),
    audience: row.audience === "groups" ? "groups" : "all",
    item_count: n,
    item_types: handbookTypeCounts(sections.flatMap((s) => s.items)),
    section_count: sections.length,
    confirm_whole: row.confirm_whole === 1,
    require_signature: row.require_signature === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    can_edit: opts.canEdit,
    introduction: row.introduction,
    groups:
      row.audience === "groups"
        ? row.group_ids.filter((g) => opts.groupNames.has(g)).map((g) => ({ id: g, name: opts.groupNames.get(g)! }))
        : [],
    sections,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    updated_by_name: row.updated_by_name,
    fingerprint: handbookFingerprint(live),
  };
}

async function progressFor(
  h: Pick<Handbook, "id" | "status" | "confirm_whole" | "fingerprint">,
  visible: boolean,
  licensed: boolean
): Promise<Handbook["progress"]> {
  if (!visible || !licensed || !h.confirm_whole || h.status !== "published") return null;
  const { audience, confirmed } = await handbookProgressCounts(h.id, h.fingerprint);
  return { audience, confirmed, pct: audience > 0 ? Math.round((confirmed * 100) / audience) : 0 };
}

async function groupNameMap(rows: HandbookRow[]): Promise<Map<number, string>> {
  if (!rows.some((r) => r.audience === "groups" && r.group_ids.length > 0)) return new Map();
  return new Map((await listGroupNames()).map((g) => [g.id, g.name]));
}

async function load(
  v: Viewer,
  row: HandbookRow,
  forEdit: boolean
): Promise<Handbook> {
  const canEdit = managesOwner(v, row.space_id);
  const [sections, items, names, licensed] = await Promise.all([
    listHandbookSectionRows([row.id]),
    listHandbookItemRows([row.id]),
    groupNameMap([row]),
    featureEnabled("policy_ack"),
  ]);
  const h = assemble(row, sections, items, { forEdit, canEdit, groupNames: names, openable: openableSpaces(v, row) });
  return { ...h, progress: await progressFor(h, seesProgress(v, canEdit), licensed) };
}

// --- Permissions -----------------------------------------------------------------------

/** May this person create any handbook (workspace, or in at least one space)? */
export async function canCreateHandbooks(user: HandbookUser): Promise<boolean> {
  const v = await viewerFor(user);
  const spaces = managedSpaces(v);
  return managesOwner(v, null) || spaces === "all" || spaces.length > 0;
}

/** Spaces the person may own a space handbook in: "all", or ids (visible spaces where handbook.manage is held). */
export async function manageableHandbookSpaces(user: HandbookUser): Promise<"all" | number[]> {
  return managedSpaces(await viewerFor(user));
}

/** May this person own a handbook in this place (null = workspace)? */
export async function canManageOwner(user: HandbookUser, spaceId: number | null): Promise<boolean> {
  return managesOwner(await viewerFor(user), spaceId);
}

/** May this person edit/publish/delete this handbook? */
export async function canManage(user: HandbookUser, handbookId: number): Promise<boolean> {
  const row = await getHandbookRow(handbookId);
  return !!row && managesOwner(await viewerFor(user), row.space_id);
}

/** May this person read this handbook? (Editors: any status. Readers: published and in the audience.) */
export async function canRead(user: HandbookUser, handbookId: number): Promise<boolean> {
  const row = await getHandbookRow(handbookId);
  return !!row && readsRow(await viewerFor(user), row);
}

/**
 * "Handbook access opens its policies": does a PUBLISHED handbook whose
 * audience holds this person contain this live, published document (in
 * `handbookId` only, when given)? Editors previewing a draft handbook are
 * served by getHandbookPolicy, which also admits them; this answers for
 * readers, which is what any widening of a document read must rest on.
 */
export async function handbookGrantsRead(userId: number, docId: number, handbookId?: number): Promise<boolean> {
  return publishedHandbookAdmits(userId, docId, handbookId ?? null);
}

/**
 * How this person reads this document: 'space' (its space is in their
 * scope, the ordinary path), 'handbook' (only through a published handbook
 * whose audience holds them, handbookGrantsRead), or null. The routes a
 * handbook's policy page calls on its own (the read confirmation, the view
 * tracker, the images in the body) widen their space check by exactly
 * this, and nothing else; a route that keeps its own draft check applies
 * it after (a handbook only ever opens a published document).
 */
export async function documentReadVia(
  user: HandbookUser,
  doc: { id: number; space_id: number }
): Promise<"space" | "handbook" | null> {
  if (scopeAllows(await spaceScopeFor(user), doc.space_id)) return "space";
  return (await handbookGrantsRead(user.id, doc.id)) ? "handbook" : null;
}

/**
 * May this person submit a read confirmation of this document?
 * `document.ack_submit` is space-scoped: held on the document's space (or
 * globally) it answers as it always has. A reader who reaches the policy
 * through a handbook may hold it on no role in that space, so there the
 * handbook stands in for the space: they must hold the permission
 * somewhere (a role that may confirm at all) AND a published handbook
 * whose audience holds them must contain the document (in `handbookId`
 * only, when given). The policy's own audience (an open assignment row)
 * is the caller's to check, as before.
 */
export async function mayConfirmPolicy(
  user: HandbookUser,
  doc: { id: number; space_id: number },
  handbookId?: number
): Promise<boolean> {
  if (await userHolds(user, "document.ack_submit", { spaceId: doc.space_id, legacyMin: "viewer" })) return true;
  if (!(await userHolds(user, "document.ack_submit", { legacyMin: "viewer" }))) return false;
  return handbookGrantsRead(user.id, doc.id, handbookId);
}

/**
 * The handbook a per-policy confirmation is made in: POST
 * /api/documents/[id]/ack with `handbook_id`, sent by the reader's confirm
 * bar. Answers the handbook's own signature switch when the person may read
 * this handbook and it holds this live document; null otherwise (the route
 * answers 404, never saying which). "Require a typed signature" then
 * applies to the confirmation exactly as a policy's own requirement does.
 */
export async function handbookConfirmationContext(
  user: HandbookUser,
  handbookId: number,
  docId: number
): Promise<{ id: number; title: string; require_signature: boolean } | null> {
  const row = await getHandbookRow(handbookId);
  if (!row || !readsRow(await viewerFor(user), row)) return null;
  const items = await listHandbookItemRows([row.id]);
  if (!items.some((i) => i.doc_id === docId && i.live)) return null;
  return { id: row.id, title: row.title, require_signature: row.require_signature === 1 };
}

/**
 * "Require a typed signature" for someone who reads this document ONLY
 * through handbooks (documentReadVia 'handbook'): on when any published
 * handbook whose audience holds them and which holds the document has it
 * on, whichever handbook the confirmation names — so naming one with the
 * switch off cannot step around one with it on. A reader of the space who
 * confirms on /doc/{id} keeps the policy's own setting.
 */
export async function handbookSignatureRequired(user: HandbookUser, docId: number): Promise<boolean> {
  return publishedHandbookRequiresSignature(user.id, docId);
}

/** The no-orphans rule: 'handbook_only' only while the document is in a published handbook. */
export async function effectiveFindMode(docId: number): Promise<FindMode> {
  const r = await documentFindModeRow(docId);
  return r?.effective_handbook_only ? "handbook_only" : "space";
}

// --- Reads ----------------------------------------------------------------------------

/**
 * Handbooks the person can read, plus drafts they can edit; title order.
 * `readableDocIds` adds each one's readable_doc_ids (the reader view's
 * documents), worked out from the rows this call loads anyway, so a caller
 * that needs them makes no query per handbook.
 */
export async function listHandbooks(user: HandbookUser, opts: { readableDocIds?: boolean } = {}): Promise<HandbookSummary[]> {
  const v = await viewerFor(user);
  const rows = (await listHandbookRows()).filter((r) => readsRow(v, r));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [sections, items, licensed] = await Promise.all([
    listHandbookSectionRows(ids),
    listHandbookItemRows(ids),
    featureEnabled("policy_ack"),
  ]);
  const out: HandbookSummary[] = [];
  for (const row of rows) {
    const canEdit = managesOwner(v, row.space_id);
    const openable = openableSpaces(v, row);
    const own = items.filter((i) => i.handbook_id === row.id);
    const h = assemble(
      row,
      sections.filter((s) => s.handbook_id === row.id),
      own,
      { forEdit: canEdit, canEdit, groupNames: new Map(), openable }
    );
    const progress = await progressFor(h, seesProgress(v, canEdit), licensed);
    out.push({
      id: h.id,
      title: h.title,
      status: h.status,
      space_id: h.space_id,
      space_name: h.space_name,
      space_slug: h.space_slug,
      space_icon: h.space_icon,
      owner_label: h.owner_label,
      audience: h.audience,
      item_count: h.item_count,
      item_types: h.item_types,
      section_count: h.section_count,
      confirm_whole: h.confirm_whole,
      require_signature: h.require_signature,
      created_at: h.created_at,
      updated_at: h.updated_at,
      published_at: h.published_at,
      can_edit: h.can_edit,
      progress,
      // The reader view's rule (assemble, forEdit off): live documents of
      // the spaces this viewer opens in it.
      ...(opts.readableDocIds
        ? { readable_doc_ids: own.filter((i) => i.live && (openable === "all" || openable.includes(i.space_id))).map((i) => i.doc_id) }
        : {}),
    });
  }
  return out;
}

/** May the person see the Handbooks nav item: can create one, or reads at least one. */
export async function seesHandbooks(user: HandbookUser): Promise<boolean> {
  const v = await viewerFor(user);
  const spaces = managedSpaces(v);
  if (managesOwner(v, null) || spaces === "all" || spaces.length > 0) return true;
  return (await listHandbookRows()).some((r) => readsRow(v, r));
}

/**
 * One handbook if the person may read it (else undefined). The reader view
 * lists only published, live items (empty sections dropped); `forEdit`
 * (editors only: undefined for anyone else) lists every live item, drafts
 * included (doc_status says which), and every section.
 */
export async function getHandbook(user: HandbookUser, id: number, opts?: { forEdit?: boolean }): Promise<Handbook | undefined> {
  const row = await getHandbookRow(id);
  if (!row) return undefined;
  const v = await viewerFor(user);
  const forEdit = opts?.forEdit === true;
  if (forEdit ? !managesOwner(v, row.space_id) : !readsRow(v, row)) return undefined;
  return load(v, row, forEdit);
}

/**
 * A document through its handbook, or undefined when the handbook doesn't
 * open it to this person (not readable, not in it, not published, or in
 * the trash). This is the reader's access path: it does not consult the
 * document's space.
 */
export async function getHandbookPolicy(user: HandbookUser, handbookId: number, docId: number): Promise<HandbookPolicy | undefined> {
  const handbook = await getHandbook(user, handbookId);
  if (!handbook) return undefined;
  const flat = handbook.sections.flatMap((s) => s.items);
  const at = flat.findIndex((i) => i.doc_id === docId);
  if (at < 0) return undefined;
  const document = await getDocument(docId);
  if (!document || document.status !== "published") return undefined;
  const item = flat[at];
  return {
    handbook,
    item,
    section: handbook.sections.find((s) => s.id === item.section_id)!,
    document,
    next: flat[at + 1] ?? null,
    prev: at > 0 ? flat[at - 1] : null,
  };
}

/** The editor's type filter (1.18.2: SOPs too); "policy" when left out. */
export type HandbookCandidateType = "policy" | "sop" | "all";

/** The editor's "Add documents" search (published, live documents the person may add to this handbook). */
export async function handbookCandidates(
  user: HandbookUser,
  handbookId: number,
  opts: { q?: string; type?: HandbookCandidateType; spaceId?: number | null; limit?: number } = {}
): Promise<HandbookCandidate[]> {
  const row = await getHandbookRow(handbookId);
  if (!row) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  const v = await viewerFor(user);
  if (!managesOwner(v, row.space_id)) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  const spaceIds = addableSpaces(v, row.space_id);
  if (spaceIds !== "all" && spaceIds.length === 0) return [];
  return handbookCandidateRows({
    handbookId,
    spaceIds,
    q: (opts.q ?? "").trim().slice(0, 200),
    type: opts.type === "all" ? null : opts.type === "sop" ? "sop" : "policy",
    spaceId: opts.spaceId ?? null,
    limit: Math.min(Math.max(1, opts.limit ?? 50), HANDBOOK_CANDIDATES_MAX),
  });
}

/**
 * Of these documents, the ones this person may add to a handbook owned by
 * `ownerSpaceId` (null = the workspace): the check every contents change
 * makes (changeContents), for a caller that needs the answer before the
 * handbook exists. The connector's create_handbook (1.18.2) refuses its
 * initial sections with it, so a bad document id never leaves an empty
 * draft behind.
 */
export async function addableDocumentIds(user: HandbookUser, ownerSpaceId: number | null, docIds: number[]): Promise<number[]> {
  const ids = [...new Set(docIds)];
  if (ids.length === 0) return [];
  return addableHandbookDocIds(ids, addableSpaces(await viewerFor(user), ownerSpaceId));
}

/** The editor's owner/audience pickers. */
export async function handbookOptions(user: HandbookUser): Promise<HandbookOptions> {
  const v = await viewerFor(user);
  const managed = managedSpaces(v);
  const [visible, groups, policy_ack] = await Promise.all([listSpaces(v.scope), listGroupNames(), featureEnabled("policy_ack")]);
  const pick = (s: { id: number; name: string; icon: string; slug: string }) => ({ id: s.id, name: s.name, icon: s.icon, slug: s.slug });
  return {
    can_create_workspace: managesOwner(v, null),
    spaces: visible.filter((s) => managed === "all" || managed.includes(s.id)).map(pick),
    visible_spaces: visible.map(pick),
    groups,
    policy_ack,
  };
}

/** Per document: the handbooks it is in, title order (for "Handbook only · in <handbook>" chips). */
export async function handbooksForDocuments(
  docIds: number[]
): Promise<Map<number, { id: number; title: string; status: HandbookStatus }[]>> {
  const out = new Map<number, { id: number; title: string; status: HandbookStatus }[]>();
  for (const r of await handbooksForDocumentRows(docIds)) {
    const list = out.get(r.doc_id) ?? [];
    list.push({ id: r.id, title: r.title, status: r.status });
    out.set(r.doc_id, list);
  }
  return out;
}

/** When this person confirmed these contents (fingerprint), or null. lib/handbook-confirm's `confirmedAt`. */
export async function handbookConfirmedAt(handbookId: number, userId: number, fingerprint: string): Promise<string | null> {
  return (await latestHandbookConfirmation(handbookId, userId, fingerprint))?.at ?? null;
}

// --- Writes -------------------------------------------------------------------------------

/**
 * A published handbook's readers are within its policies' audience ceiling
 * (lib/db ACK_DOC_VISIBILITY), so a change to who reads it, or to what it
 * holds, re-runs those policies' reconcile, as a space change does. Best
 * effort: the write it follows has happened, and the hourly sweep is the
 * safety net for a reconcile that failed. Only with read confirmation
 * licensed (the sweep is too).
 */
async function reconcileHandbookPolicies(handbookId: number, extraDocIds: number[] = []): Promise<void> {
  try {
    if (!(await featureEnabled("policy_ack"))) return;
    await reconcilePoliciesForHandbook(handbookId, extraDocIds);
  } catch (e) {
    console.error(`[handbooks] could not reconcile the policies of handbook ${handbookId}:`, e);
  }
}

/** The row, and the viewer, when the person may edit it; throws 404 otherwise (never 403: no existence oracle). */
async function editable(user: HandbookUser, id: number): Promise<{ v: Viewer; row: HandbookRow }> {
  const row = await getHandbookRow(id);
  if (!row) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  const v = await viewerFor(user);
  if (!managesOwner(v, row.space_id)) {
    // Someone who can read it learns they can't edit it; anyone else that it isn't there.
    throw readsRow(v, row) ? new HandbookError("You can't edit this handbook.", 403) : new HandbookError(HANDBOOK_NOT_FOUND, 404);
  }
  return { v, row };
}

async function assertOwner(v: Viewer, spaceId: number | null): Promise<void> {
  if (spaceId !== null && !(await getSpaceById(spaceId))) throw new HandbookError(HANDBOOK_SPACE_MISSING, 400);
  if (!managesOwner(v, spaceId)) throw new HandbookError(HANDBOOK_OWNER_DENIED, 403);
}

export async function createHandbook(
  user: HandbookUser,
  input: HandbookInput,
  req?: Request,
  ctx?: HandbookWriteContext
): Promise<Handbook> {
  const v = await viewerFor(user);
  await assertOwner(v, input.space_id);
  const id = await createHandbookRow(
    { ...input, group_ids: input.audience === "groups" ? input.group_ids : [] },
    { id: user.id, name: actorName(user) },
    HANDBOOK_FIRST_SECTION
  );
  const h = (await getHandbook(user, id, { forEdit: true }))!;
  await audit({
    actor: auditActor(user),
    action: "handbook.created",
    targetType: "handbook",
    targetId: id,
    targetLabel: h.title,
    details: {
      handbook_id: id,
      owner: h.owner_label,
      space_id: h.space_id,
      audience: h.audience,
      group_ids: h.groups.map((g) => g.id),
      confirm_whole: h.confirm_whole,
      require_signature: h.require_signature,
      ...viaDetails(ctx),
    },
    ip: auditIp(req, ctx),
  });
  return h;
}

/**
 * Change the details. `ifUpdatedAt` (the handbook's updated_at as the
 * editor last loaded it) makes the save conditional: when another save
 * moved it since, nothing is written and the answer is 409
 * HANDBOOK_CHANGED_ELSEWHERE. The answer's updated_at is the new token.
 */
export async function updateHandbook(
  user: HandbookUser,
  id: number,
  patch: HandbookPatch,
  req?: Request,
  opts: { ifUpdatedAt?: string } = {}
): Promise<Handbook> {
  const { v, row } = await editable(user, id);
  const ownerMoves = patch.space_id !== undefined && patch.space_id !== row.space_id;
  if (ownerMoves) await assertOwner(v, patch.space_id!);
  const audience = patch.audience ?? row.audience;
  const groupIds = patch.group_ids ?? row.group_ids;
  if (row.status === "published" && audience === "groups" && groupIds.length === 0) {
    throw new HandbookError(HANDBOOK_GROUPS_REQUIRED, 400);
  }
  // Who reads it, or who owns it (and so whose readers they are): only for
  // someone who could have added everything it holds. A details form that
  // sends the same audience back changes nothing and is not refused.
  const sameGroups = (a: number[], b: number[]) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));
  const readersMove = audience !== row.audience || (audience === "groups" && !sameGroups(groupIds, row.group_ids));
  if (ownerMoves || readersMove) {
    await assertOwnContents(v, id, patch.space_id !== undefined ? patch.space_id : row.space_id);
  }
  const before = await load(v, row, true);
  const written = await updateHandbookRow(id, patch, actorName(user), { ifUpdatedAt: opts.ifUpdatedAt });
  if (written === "conflict") throw new HandbookError(HANDBOOK_CHANGED_ELSEWHERE, 409);
  if (written === null) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  const after = (await getHandbook(user, id, { forEdit: true })) ?? before;
  const changed = (Object.keys(patch) as (keyof HandbookPatch)[]).filter((k) => {
    if (k === "group_ids") return JSON.stringify([...before.groups.map((g) => g.id)].sort()) !== JSON.stringify([...after.groups.map((g) => g.id)].sort());
    return (before as unknown as Record<string, unknown>)[k] !== (after as unknown as Record<string, unknown>)[k];
  });
  if (after.status === "published" && changed.some((k) => k === "audience" || k === "group_ids" || k === "space_id")) {
    await reconcileHandbookPolicies(id);
  }
  if (changed.length > 0) {
    await audit({
      actor: auditActor(user),
      action: "handbook.updated",
      targetType: "handbook",
      targetId: id,
      targetLabel: after.title,
      details: {
        handbook_id: id,
        changed,
        ...(changed.includes("title") ? { renamed_from: before.title } : {}),
        ...(changed.includes("space_id") ? { owner_from: before.owner_label, owner_to: after.owner_label } : {}),
        ...(changed.includes("audience") || changed.includes("group_ids")
          ? { audience: after.audience, group_ids: after.groups.map((g) => g.id) }
          : {}),
        ...(changed.includes("confirm_whole") ? { confirm_whole: after.confirm_whole } : {}),
        ...(changed.includes("require_signature") ? { require_signature: after.require_signature } : {}),
      },
      ip: req ? ipFrom(req) : null,
    });
  }
  return after;
}

export async function deleteHandbook(user: HandbookUser, id: number, req?: Request, ctx?: HandbookWriteContext): Promise<void> {
  const { v, row } = await editable(user, id);
  const h = await load(v, row, true);
  await deleteHandbookRow(id);
  if (row.status === "published") await reconcileHandbookPolicies(id, h.sections.flatMap((s) => s.items.map((i) => i.doc_id)));
  await audit({
    actor: auditActor(user),
    action: "handbook.deleted",
    targetType: "handbook",
    targetId: id,
    targetLabel: row.title,
    details: {
      handbook_id: id,
      status: row.status,
      owner: h.owner_label,
      policies: h.item_count,
      doc_ids: h.sections.flatMap((s) => s.items.map((i) => i.doc_id)),
      ...viaDetails(ctx),
    },
    ip: auditIp(req, ctx),
  });
}

export async function publishHandbook(user: HandbookUser, id: number, publish: boolean, req?: Request): Promise<Handbook> {
  const { v, row } = await editable(user, id);
  const target = publish ? "published" : "draft";
  if (row.status === target) return load(v, row, true);
  if (publish) {
    const items = await listHandbookItemRows([id]);
    if (!items.some((i) => i.live)) throw new HandbookError(HANDBOOK_EMPTY_PUBLISH, 409);
    if (row.audience === "groups" && row.group_ids.length === 0) throw new HandbookError(HANDBOOK_GROUPS_REQUIRED, 409);
    // Publishing opens every document it holds to its readers.
    await assertOwnContents(v, id, row.space_id);
  }
  await setHandbookStatusRow(id, target, actorName(user));
  await reconcileHandbookPolicies(id);
  const h = (await getHandbook(user, id, { forEdit: true }))!;
  const details = { handbook_id: id, owner: h.owner_label, policies: h.sections.reduce((n, s) => n + s.items.filter((i) => i.doc_status === "published").length, 0), audience: h.audience, fingerprint: h.fingerprint };
  if (publish) {
    await audit({ actor: auditActor(user), action: "handbook.published", targetType: "handbook", targetId: id, targetLabel: h.title, details, ip: req ? ipFrom(req) : null });
  } else {
    await audit({ actor: auditActor(user), action: "handbook.unpublished", targetType: "handbook", targetId: id, targetLabel: h.title, details, ip: req ? ipFrom(req) : null });
  }
  return h;
}

// --- Contents ---------------------------------------------------------------------------

type Draft = HandbookContentsDraft;

function flatIds(d: Draft): number[] {
  return d.sections.flatMap((s) => s.doc_ids);
}

function sectionIndex(d: Draft, sectionId: number): number {
  const i = d.sections.findIndex((s) => s.id === sectionId);
  if (i < 0) throw new HandbookError(HANDBOOK_SECTION_NOT_FOUND, 404);
  return i;
}

function itemAt(d: Draft, docId: number): { s: number; i: number } {
  for (let s = 0; s < d.sections.length; s++) {
    const i = d.sections[s].doc_ids.indexOf(docId);
    if (i >= 0) return { s, i };
  }
  throw new HandbookError(HANDBOOK_ITEM_NOT_FOUND, 404);
}

/**
 * The one path every contents change takes: the edit check, the addable
 * check for documents new to the handbook (before the transaction, so no
 * client is held while it queries), the locked rewrite, and one
 * handbook.contents_changed row naming what moved.
 */
async function changeContents(
  user: HandbookUser,
  id: number,
  req: Request | undefined,
  plan: { adding: number[]; fn: (d: Draft) => Draft; op: string; ifUpdatedAt?: string; ctx?: HandbookWriteContext }
): Promise<Handbook> {
  const { v, row } = await editable(user, id);
  const present = new Set((await listHandbookItemRows([id])).map((r) => r.doc_id));
  const fresh = [...new Set(plan.adding)].filter((d) => !present.has(d));
  if (fresh.length > 0) {
    const ok = new Set(await addableHandbookDocIds(fresh, addableSpaces(v, row.space_id)));
    if (fresh.some((d) => !ok.has(d))) throw new HandbookError(HANDBOOK_DOCS_INVALID, 400);
  }
  const result = await mutateHandbookContents(
    id,
    (current) => {
      const next = plan.fn(current);
      if (next.sections.length < 1 || next.sections.length > HANDBOOK_SECTIONS_MAX) {
        throw new HandbookError(next.sections.length < 1 ? HANDBOOK_LAST_SECTION : HANDBOOK_SECTIONS_RANGE, next.sections.length < 1 ? 409 : 400);
      }
      const all = flatIds(next);
      if (new Set(all).size !== all.length) throw new HandbookError(HANDBOOK_DOC_IDS_INVALID, 400);
      if (all.length > HANDBOOK_ITEMS_MAX) throw new HandbookError(HANDBOOK_ITEMS_RANGE, 400);
      // Only documents already in the handbook or vetted above may appear.
      const vetted = new Set([...flatIds(current), ...fresh]);
      if (all.some((d) => !vetted.has(d))) throw new HandbookError(HANDBOOK_DOCS_INVALID, 400);
      return next;
    },
    actorName(user),
    { ifUpdatedAt: plan.ifUpdatedAt }
  );
  if (result === "conflict") throw new HandbookError(HANDBOOK_CHANGED_ELSEWHERE, 409);
  if (!result) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  const h = (await getHandbook(user, id, { forEdit: true }))!;
  const { before, after } = result;
  const beforeIds = flatIds(before);
  const afterIds = flatIds(after);
  const added = afterIds.filter((d) => !beforeIds.includes(d));
  const removed = beforeIds.filter((d) => !afterIds.includes(d));
  if (h.status === "published" && (added.length > 0 || removed.length > 0)) await reconcileHandbookPolicies(id, removed);
  const shape = (d: Draft) => JSON.stringify(d.sections.map((s) => [s.id, s.title, s.doc_ids]));
  if (shape(before) !== shape(after)) {
    await audit({
      actor: auditActor(user),
      action: "handbook.contents_changed",
      targetType: "handbook",
      targetId: id,
      targetLabel: h.title,
      details: {
        handbook_id: id,
        op: plan.op,
        added,
        removed,
        policies: afterIds.length,
        sections: after.sections.map((s) => ({ id: s.id, title: s.title, doc_ids: s.doc_ids })),
        sections_before: before.sections.map((s) => ({ id: s.id, title: s.title, doc_ids: s.doc_ids })),
        ...viaDetails(plan.ctx),
      },
      ip: auditIp(req, plan.ctx),
    });
  }
  return h;
}

/**
 * Replace the Contents card wholesale (sections in order, each with its
 * doc ids in order). A document the editor could not see — one in the
 * trash, which every read leaves out — is kept where it was rather than
 * dropped by a save that never showed it. `ifUpdatedAt` makes the save
 * conditional, as updateHandbook's does (409 when another save came first).
 */
export async function setHandbookContents(
  user: HandbookUser,
  id: number,
  input: HandbookContentsInput,
  req?: Request,
  opts: { ifUpdatedAt?: string; ctx?: HandbookWriteContext } = {}
): Promise<Handbook> {
  const shown = new Set((await listHandbookItemRows([id])).map((r) => r.doc_id));
  return changeContents(user, id, req, {
    op: "replace",
    ifUpdatedAt: opts.ifUpdatedAt,
    ctx: opts.ctx,
    adding: input.sections.flatMap((s) => s.doc_ids),
    fn: (current) => {
      const next: Draft = {
        sections: input.sections.map((s) => ({ id: s.id ?? null, title: s.title, doc_ids: [...s.doc_ids] })),
      };
      const named = new Set(flatIds(next));
      current.sections.forEach((cs) => {
        for (const d of cs.doc_ids) {
          if (shown.has(d) || named.has(d)) continue;
          const home = next.sections.find((s) => s.id === cs.id) ?? next.sections[next.sections.length - 1];
          home?.doc_ids.push(d);
        }
      });
      return next;
    },
  });
}

/** Append documents to the end of a section (default: the last section); ones already in the handbook are skipped. */
export async function addHandbookItems(user: HandbookUser, id: number, docIds: number[], sectionId?: number, req?: Request): Promise<Handbook> {
  return changeContents(user, id, req, {
    op: "add",
    adding: docIds,
    fn: (d) => {
      const at = sectionId !== undefined ? sectionIndex(d, sectionId) : d.sections.length - 1;
      if (at < 0) d.sections.push({ id: null, title: HANDBOOK_FIRST_SECTION, doc_ids: [] });
      const target = d.sections[Math.max(at, 0)];
      const present = new Set(flatIds(d));
      for (const doc of docIds) {
        if (present.has(doc)) continue;
        present.add(doc);
        target.doc_ids.push(doc);
      }
      return d;
    },
  });
}

export async function removeHandbookItem(user: HandbookUser, id: number, docId: number, req?: Request): Promise<Handbook> {
  return changeContents(user, id, req, {
    op: "remove",
    adding: [],
    fn: (d) => {
      const { s, i } = itemAt(d, docId);
      d.sections[s].doc_ids.splice(i, 1);
      return d;
    },
  });
}

/** Up/down within the reading order (crossing into the neighbouring section at an edge), or to another section's end. */
export async function moveHandbookItem(
  user: HandbookUser,
  id: number,
  docId: number,
  move: { direction: "up" | "down" } | { sectionId: number },
  req?: Request
): Promise<Handbook> {
  return changeContents(user, id, req, {
    op: "move",
    adding: [],
    fn: (d) => {
      const { s, i } = itemAt(d, docId);
      const list = d.sections[s].doc_ids;
      if ("sectionId" in move) {
        const to = sectionIndex(d, move.sectionId);
        list.splice(i, 1);
        d.sections[to].doc_ids.push(docId);
      } else if (move.direction === "up") {
        if (i > 0) {
          [list[i - 1], list[i]] = [list[i], list[i - 1]];
        } else if (s > 0) {
          list.splice(i, 1);
          d.sections[s - 1].doc_ids.push(docId);
        }
      } else if (i < list.length - 1) {
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
      } else if (s < d.sections.length - 1) {
        list.splice(i, 1);
        d.sections[s + 1].doc_ids.unshift(docId);
      }
      return d;
    },
  });
}

export async function addHandbookSection(user: HandbookUser, id: number, title: string, req?: Request): Promise<Handbook> {
  const name = normaliseSectionTitle(title) || HANDBOOK_NEW_SECTION;
  return changeContents(user, id, req, {
    op: "add_section",
    adding: [],
    fn: (d) => {
      d.sections.push({ id: null, title: name, doc_ids: [] });
      return d;
    },
  });
}

export async function renameHandbookSection(user: HandbookUser, id: number, sectionId: number, title: string, req?: Request): Promise<Handbook> {
  const name = normaliseSectionTitle(title);
  if (!name) throw new HandbookError(HANDBOOK_SECTION_TITLE_REQUIRED, 400);
  return changeContents(user, id, req, {
    op: "rename_section",
    adding: [],
    fn: (d) => {
      d.sections[sectionIndex(d, sectionId)].title = name;
      return d;
    },
  });
}

export async function moveHandbookSection(user: HandbookUser, id: number, sectionId: number, direction: "up" | "down", req?: Request): Promise<Handbook> {
  return changeContents(user, id, req, {
    op: "move_section",
    adding: [],
    fn: (d) => {
      const i = sectionIndex(d, sectionId);
      const j = direction === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < d.sections.length) [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]];
      return d;
    },
  });
}

/** Removes a section; its items move to the end of the previous section (or the start of the next). The last section can't be removed. */
export async function removeHandbookSection(user: HandbookUser, id: number, sectionId: number, req?: Request): Promise<Handbook> {
  return changeContents(user, id, req, {
    op: "remove_section",
    adding: [],
    fn: (d) => {
      const i = sectionIndex(d, sectionId);
      if (d.sections.length === 1) throw new HandbookError(HANDBOOK_LAST_SECTION, 409);
      const [gone] = d.sections.splice(i, 1);
      if (i > 0) d.sections[i - 1].doc_ids.push(...gone.doc_ids);
      else d.sections[0].doc_ids.unshift(...gone.doc_ids);
      return d;
    },
  });
}

/** One "Where people find it" change: the document and the mode to store. */
export interface FindModeChange {
  doc_id: number;
  find_mode: FindMode;
}

/** The changes, one per document; refuses (400) a document given two different modes. */
function oncePerDocument(changes: readonly FindModeChange[]): FindModeChange[] {
  if (changes.length > HANDBOOK_ITEMS_MAX) throw new HandbookError(HANDBOOK_FIND_MODES_RANGE, 400);
  const out = new Map<number, FindMode>();
  for (const c of changes) {
    const seen = out.get(c.doc_id);
    if (seen !== undefined && seen !== c.find_mode) throw new HandbookError(HANDBOOK_FIND_MODE_TWICE, 400);
    out.set(c.doc_id, c.find_mode);
  }
  return [...out].map(([doc_id, find_mode]) => ({ doc_id, find_mode }));
}

/**
 * Of these find-mode changes (one per document, at most
 * HANDBOOK_ITEMS_MAX), the ones that would change what is stored, checked
 * as setItemFindModes checks them: refuses (403) when the person may not
 * change a document's find mode (handbook.manage on its own space), or
 * (404) when a document is unknown or in the trash. One permission load
 * and one query, whatever the number of documents. The connector's
 * update_handbook_contents (1.18.2) calls it before saving the contents,
 * so a refusal saves nothing; it does not check that the documents are in
 * the handbook (they may be about to be added), setItemFindModes does.
 */
export async function pendingFindModeChanges(user: HandbookUser, changes: readonly FindModeChange[]): Promise<FindModeChange[]> {
  const wanted = oncePerDocument(changes);
  if (wanted.length === 0) return [];
  const [v, rows] = await Promise.all([viewerFor(user), documentFindModeRows(wanted.map((c) => c.doc_id))]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pending: FindModeChange[] = [];
  for (const c of wanted) {
    const doc = byId.get(c.doc_id);
    if (!doc) throw new HandbookError(HANDBOOK_ITEM_NOT_FOUND, 404);
    if ((doc.find_mode === "handbook_only" ? "handbook_only" : "space") === c.find_mode) continue;
    if (!managesOwner(v, doc.space_id)) throw new HandbookError(HANDBOOK_FIND_MODE_DENIED, 403);
    pending.push(c);
  }
  return pending;
}

/**
 * "Where people find it" for one item. Stored on the document, so it holds
 * in every handbook the document is in; changing it needs handbook.manage
 * where the document lives (a space handbook admin cannot hide another
 * space's document), on top of editing this handbook. Metadata only: the
 * document's updated_at and confirmation marker do not move.
 */
export async function setItemFindMode(
  user: HandbookUser,
  id: number,
  docId: number,
  mode: FindMode,
  req?: Request,
  ctx?: HandbookWriteContext
): Promise<Handbook> {
  return setItemFindModes(user, id, [{ doc_id: docId, find_mode: mode }], req, ctx);
}

/**
 * setItemFindMode for several items at once: every change is checked
 * first (each document in this handbook, handbook.manage on each one's
 * space; one refusal writes nothing), the changed ones are written in one
 * statement, each gets its own handbook.find_mode_changed row (as the
 * item route writes it), and the handbook is loaded once at the end. A
 * document given its current mode is not written or audited.
 */
export async function setItemFindModes(
  user: HandbookUser,
  id: number,
  changes: readonly FindModeChange[],
  req?: Request,
  ctx?: HandbookWriteContext
): Promise<Handbook> {
  const wanted = oncePerDocument(changes);
  const { v, row } = await editable(user, id);
  const items = new Map((await listHandbookItemRows([id])).map((r) => [r.doc_id, r]));
  for (const c of wanted) {
    const item = items.get(c.doc_id);
    if (!item) throw new HandbookError(HANDBOOK_ITEM_NOT_FOUND, 404);
    if (!managesOwner(v, item.space_id)) throw new HandbookError(HANDBOOK_FIND_MODE_DENIED, 403);
  }
  const writes = wanted.filter((c) => items.get(c.doc_id)!.find_mode !== c.find_mode);
  const before = await setDocumentFindModes(writes);
  for (const c of writes) {
    const from = before.get(c.doc_id);
    if (from === undefined || from === c.find_mode) continue;
    const item = items.get(c.doc_id)!;
    await audit({
      actor: auditActor(user),
      action: "handbook.find_mode_changed",
      targetType: "document",
      targetId: c.doc_id,
      targetLabel: item.title,
      details: { handbook_id: id, handbook: row.title, doc_id: c.doc_id, space_id: item.space_id, from, to: c.find_mode, ...viaDetails(ctx) },
      ip: auditIp(req, ctx),
    });
  }
  return load(v, row, true);
}

/** Audits handbook.printed for someone who may read the handbook (POST /api/handbooks/[id]/printed). */
export async function recordHandbookPrinted(user: HandbookUser, id: number, req?: Request): Promise<void> {
  const h = await getHandbook(user, id);
  if (!h) throw new HandbookError(HANDBOOK_NOT_FOUND, 404);
  await audit({
    actor: auditActor(user),
    action: "handbook.printed",
    targetType: "handbook",
    targetId: id,
    targetLabel: h.title,
    details: { handbook_id: id, status: h.status, policies: h.item_count, fingerprint: h.fingerprint },
    ip: req ? ipFrom(req) : null,
  });
}

/**
 * Write the whole-handbook confirmation record (handbook_confirmations) —
 * lib/handbook-confirm's `recordHandbook` writer. Answers null, writing
 * nothing, when the handbook is gone, its contents no longer match
 * `fingerprint` (it changed under the confirmation), or this person
 * already holds a record of these contents (a concurrent submit: one
 * record each). The audit row is the caller's (handbook.confirmed), and
 * only for a record this call wrote.
 */
export async function recordHandbookConfirmation(row: {
  handbook_id: number;
  user_id: number;
  fingerprint: string;
  user_name?: string;
  policies_confirmed?: number;
  signed_name?: string | null;
  ip?: string | null;
  user_agent?: string;
}): Promise<{ at: string } | null> {
  const h = await getHandbookRow(row.handbook_id);
  if (!h) return null;
  const live = (await listHandbookItemRows([h.id])).filter((i) => i.live);
  if (handbookFingerprint(live) !== row.fingerprint) return null;
  let name = row.user_name;
  if (name === undefined) {
    const u = await getUserById(row.user_id);
    name = u?.name || u?.username || "";
  }
  const written = await insertHandbookConfirmation(null, {
    handbook_id: h.id,
    handbook_title: h.title,
    user_id: row.user_id,
    user_name: name,
    fingerprint: row.fingerprint,
    items: live.map((i) => ({ doc_id: i.doc_id, version_id: i.version_id })),
    policies_confirmed: row.policies_confirmed ?? 0,
    signed_name: row.signed_name ?? null,
    ip: row.ip ?? "",
    user_agent: row.user_agent ?? "",
  });
  return written ? { at: written.at } : null;
}

// --- Request parsing (pure) -----------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** Positive safe integers, deduped in order; null when any entry is not one. */
function idList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** A title as stored: trimmed, inner whitespace collapsed. */
export function normaliseHandbookTitle(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** A section title as stored; '' when unusable or too long. */
export function normaliseSectionTitle(raw: unknown): string {
  const t = normaliseHandbookTitle(raw);
  return t.length <= HANDBOOK_SECTION_TITLE_MAX ? t : "";
}

/** Parse the fields both POST and PATCH accept; only the keys present are returned. */
function parseFields(b: Record<string, unknown>): Parsed<HandbookPatch> {
  const out: HandbookPatch = {};
  if (b.title !== undefined) {
    const title = normaliseHandbookTitle(b.title);
    if (!title || title.length > HANDBOOK_TITLE_MAX) return { ok: false, error: HANDBOOK_TITLE_REQUIRED };
    out.title = title;
  }
  if (b.space_id !== undefined) {
    if (b.space_id !== null && (typeof b.space_id !== "number" || !Number.isSafeInteger(b.space_id) || b.space_id <= 0)) {
      return { ok: false, error: HANDBOOK_OWNER_INVALID };
    }
    out.space_id = b.space_id as number | null;
  }
  if (b.introduction !== undefined) {
    if (typeof b.introduction !== "string") return { ok: false, error: "'introduction' must be text." };
    const intro = b.introduction.replace(/\r\n/g, "\n").trim();
    if (intro.length > HANDBOOK_INTRO_MAX) return { ok: false, error: HANDBOOK_INTRO_TOO_LONG };
    out.introduction = intro;
  }
  if (b.audience !== undefined) {
    if (b.audience !== "all" && b.audience !== "groups") return { ok: false, error: HANDBOOK_AUDIENCE_INVALID };
    out.audience = b.audience;
  }
  if (b.group_ids !== undefined) {
    const ids = idList(b.group_ids);
    if (!ids || ids.length > HANDBOOK_GROUPS_MAX) return { ok: false, error: HANDBOOK_GROUPS_INVALID };
    out.group_ids = ids;
  }
  for (const key of ["confirm_whole", "require_signature"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "boolean") return { ok: false, error: `'${key}' must be true or false.` };
    out[key] = b[key] as boolean;
  }
  return { ok: true, value: out };
}

/** POST /api/handbooks: { title, space_id?, introduction?, audience?, group_ids?, confirm_whole?, require_signature? }. */
export function parseHandbookInput(body: unknown): Parsed<HandbookInput> {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Send a JSON object." };
  if (b.title === undefined) return { ok: false, error: HANDBOOK_TITLE_REQUIRED };
  const f = parseFields(b);
  if (!f.ok) return f;
  return {
    ok: true,
    value: {
      title: f.value.title!,
      space_id: f.value.space_id ?? null,
      introduction: f.value.introduction ?? "",
      audience: f.value.audience ?? "all",
      group_ids: f.value.group_ids ?? [],
      confirm_whole: f.value.confirm_whole ?? false,
      require_signature: f.value.require_signature ?? false,
    },
  };
}

/** PATCH /api/handbooks/[id]: any subset of the POST fields; at least one. */
export function parseHandbookPatch(body: unknown): Parsed<HandbookPatch> {
  const b = asObject(body);
  if (!b) return { ok: false, error: "Send a JSON object." };
  const f = parseFields(b);
  if (!f.ok) return f;
  if (Object.keys(f.value).length === 0) return { ok: false, error: HANDBOOK_NOTHING_TO_CHANGE };
  return f;
}

/**
 * The optional `if_updated_at` of PATCH /api/handbooks/[id] and PUT
 * …/contents: the handbook's updated_at as the editor last loaded it (an
 * ISO timestamp), normalised; undefined when absent (an unconditional save).
 */
export function parseIfUpdatedAt(body: unknown): Parsed<string | undefined> {
  const raw = asObject(body)?.if_updated_at;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const at = typeof raw === "string" && raw.length <= 64 ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) return { ok: false, error: HANDBOOK_IF_UPDATED_AT_INVALID };
  return { ok: true, value: at.toISOString() };
}

/** PUT /api/handbooks/[id]/contents: { sections: [{ id?, title, doc_ids }] }, 1..50 sections, each document once. */
export function parseHandbookContents(body: unknown): Parsed<HandbookContentsInput> {
  const b = asObject(body);
  if (!b || !Array.isArray(b.sections)) return { ok: false, error: "Send { sections: [{ id?, title, doc_ids }] }." };
  if (b.sections.length < 1 || b.sections.length > HANDBOOK_SECTIONS_MAX) return { ok: false, error: HANDBOOK_SECTIONS_RANGE };
  const sections: HandbookContentsInput["sections"] = [];
  const seen = new Set<number>();
  for (const raw of b.sections) {
    const s = asObject(raw);
    if (!s) return { ok: false, error: "Each section must be an object." };
    const title = normaliseSectionTitle(s.title);
    if (!title) return { ok: false, error: HANDBOOK_SECTION_TITLE_REQUIRED };
    if (s.id !== undefined && s.id !== null && (typeof s.id !== "number" || !Number.isSafeInteger(s.id) || s.id <= 0)) {
      return { ok: false, error: "A section id must be a positive integer." };
    }
    const docIds = s.doc_ids === undefined ? [] : idList(s.doc_ids);
    if (!docIds || (Array.isArray(s.doc_ids) && docIds.length !== s.doc_ids.length)) return { ok: false, error: HANDBOOK_DOC_IDS_INVALID };
    for (const d of docIds) {
      if (seen.has(d)) return { ok: false, error: HANDBOOK_DOC_IDS_INVALID };
      seen.add(d);
    }
    sections.push({ ...(typeof s.id === "number" ? { id: s.id } : {}), title, doc_ids: docIds });
  }
  if (seen.size > HANDBOOK_ITEMS_MAX) return { ok: false, error: HANDBOOK_ITEMS_RANGE };
  return { ok: true, value: { sections } };
}

/** documents.summary_points as stored: up to 5 trimmed, non-empty bullets of up to 200 characters (blank lines dropped). */
export function parseSummaryPoints(raw: unknown): Parsed<string[]> {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) return { ok: false, error: SUMMARY_POINTS_INVALID };
  const points = (raw as string[]).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (points.length > SUMMARY_POINTS_MAX || points.some((p) => p.length > SUMMARY_POINT_MAX)) {
    return { ok: false, error: SUMMARY_POINTS_INVALID };
  }
  return { ok: true, value: points };
}

/** documents.applies_to as stored: trimmed, inner whitespace collapsed, up to 200 characters. */
export function parseAppliesTo(raw: unknown): Parsed<string> {
  if (raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: APPLIES_TO_INVALID };
  const v = raw.replace(/\s+/g, " ").trim();
  if (v.length > APPLIES_TO_MAX) return { ok: false, error: APPLIES_TO_INVALID };
  return { ok: true, value: v };
}

export function isFindMode(v: unknown): v is FindMode {
  return v === "space" || v === "handbook_only";
}
