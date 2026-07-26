// Shared model for the Confluence / Notion migration importers.
//
// Each source adapter reads a vendor export zip and returns a normalized tree
// of pages (with hierarchy and referenced binary assets). The orchestrator in
// ./index.ts turns that tree into CompassDocs spaces, documents, nested-page
// parenting, and attachments — reusing the same db primitives the app uses.

export type ImportSource = "notion" | "confluence";

/** A binary asset referenced by a page (image or file attachment). */
export interface ParsedAsset {
  /** The href/src exactly as it appears in the source page body. */
  ref: string;
  /** Path of the asset inside the zip, if it resolves to one. */
  zipPath: string;
  /** Original file name to preserve in the attachment record. */
  filename: string;
}

/** One imported page, already converted to CompassDocs Markdown. */
export interface ParsedPage {
  /** Stable key within this import (used to wire up parent/child links). */
  key: string;
  /** Parent page key, or null for a top-level page. */
  parentKey: string | null;
  title: string;
  /** CompassDocs-flavored Markdown (assets still point at their source refs). */
  markdown: string;
  /** Assets this page references, to be uploaded and rewritten. */
  assets: ParsedAsset[];
}

export interface ParsedExport {
  source: ImportSource;
  /** Suggested space name when importing everything into one new space. */
  suggestedSpaceName: string;
  pages: ParsedPage[];
  /** Non-fatal notes surfaced to the admin (skipped files, odd structures). */
  warnings: string[];
}

export interface MigrateOptions {
  /** Import into this existing space id, or omit to create a new space. */
  targetSpaceId?: number;
  /** Name for the new space when targetSpaceId is not given. */
  newSpaceName?: string;
  /** Publish imported docs (else they land as drafts for review). */
  publish?: boolean;
}

export interface MigrateResult {
  source: ImportSource;
  spaceId: number;
  spaceName: string;
  spaceCreated: boolean;
  pagesCreated: number;
  attachmentsCreated: number;
  skipped: number;
  warnings: string[];
}
