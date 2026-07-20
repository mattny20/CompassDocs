// Public share links: a high-entropy tokenized URL (/share/<token>) that
// exposes exactly one published document, read-only, to anyone holding the
// link. Complements the space-level public site: share one SOP with a
// customer without opening the whole space. The feature is an admin switch
// (Settings → Public site), off by default; each doc has at most one active
// link, and revoking keeps the row for the audit trail. Server-only.

import "server-only";
import { randomBytes } from "crypto";
import { pool, getSetting, setSetting, getDocument } from "./db";
import type { DocumentWithSpace } from "./types";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

export interface DocShare {
  id: number;
  document_id: number;
  token: string;
  created_by: number | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const; // plus "never"

export async function shareLinksEnabled(): Promise<boolean> {
  return (await getSetting("share_links_enabled")) === "1";
}

export async function setShareLinksEnabled(on: boolean): Promise<void> {
  await setSetting("share_links_enabled", on ? "1" : "0");
}

/** The doc's active (non-revoked, non-expired) share link, if any. */
export async function getActiveShare(docId: number): Promise<DocShare | undefined> {
  return (
    await q<DocShare>(
      `SELECT * FROM doc_shares
       WHERE document_id = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY id DESC LIMIT 1`,
      [docId]
    )
  )[0];
}

/** Create a fresh link (revoking any previous active one). */
export async function createShare(
  docId: number,
  userId: number,
  expiresDays: number | null
): Promise<DocShare> {
  await q("UPDATE doc_shares SET revoked_at = now() WHERE document_id = $1 AND revoked_at IS NULL", [docId]);
  const token = randomBytes(24).toString("base64url");
  return (
    await q<DocShare>(
      `INSERT INTO doc_shares (document_id, token, created_by, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)
       RETURNING *`,
      [docId, token, userId, expiresDays]
    )
  )[0];
}

/** Revoke the doc's active link. Returns false when there was none. */
export async function revokeShare(docId: number): Promise<boolean> {
  const r = await pool().query(
    "UPDATE doc_shares SET revoked_at = now() WHERE document_id = $1 AND revoked_at IS NULL",
    [docId]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Resolve a token to its live document — the security gate for /share pages
 * and token-scoped attachment access. Null unless the feature is on, the
 * link is active and unexpired, and the doc is a live published non-branch.
 */
export async function resolveShare(
  token: string
): Promise<{ share: DocShare; doc: DocumentWithSpace } | null> {
  if (!token || token.length > 64) return null;
  if (!(await shareLinksEnabled())) return null;
  const share = (
    await q<DocShare>(
      `SELECT * FROM doc_shares
       WHERE token = $1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [token]
    )
  )[0];
  if (!share) return null;
  const doc = await getDocument(share.document_id); // undefined when trashed
  if (!doc || doc.status !== "published" || doc.branch_of !== null) return null;
  return { share, doc };
}

/** Count a share-page view (fire-and-forget from the page). */
export async function recordShareView(shareId: number): Promise<void> {
  try {
    await q(
      "UPDATE doc_shares SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1",
      [shareId]
    );
  } catch {
    /* best effort */
  }
}
