// Scheduled publish / auto-unpublish. Documents carry two one-shot
// timestamps: publish_at (a draft goes live at that time) and archive_at (a
// published doc returns to draft). The minute tick claims due rows with a
// single atomic UPDATE — safe across concurrent app instances — then sends
// the same notifications a manual publish would. Server-only.

import "server-only";
import { pool } from "./db";
import { audit } from "./audit";

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

/** Set/clear a doc's schedule. Values are ISO strings or null to clear. */
export async function setDocSchedule(
  docId: number,
  patch: { publishAt?: string | null; archiveAt?: string | null }
): Promise<void> {
  if (patch.publishAt !== undefined) {
    await q("UPDATE documents SET publish_at = $2 WHERE id = $1", [docId, patch.publishAt]);
  }
  if (patch.archiveAt !== undefined) {
    await q("UPDATE documents SET archive_at = $2 WHERE id = $1", [docId, patch.archiveAt]);
  }
}

// Known benign race: a PUT in flight while the tick publishes the same doc
// computes its "was published" flag from a pre-tick snapshot, which can at
// worst duplicate one subscriber notification. Fixing it means an atomic
// prev-status capture inside updateDocument; accepted as-is for now.
/** Fire due schedules. Driven by the instrumentation minute tick. */
export async function runDueDocSchedules(): Promise<void> {
  // A doc published (or trashed/branched) by hand in the meantime just gets
  // its stale schedule cleared — never re-fired.
  await q(
    `UPDATE documents SET publish_at = NULL
     WHERE publish_at IS NOT NULL AND publish_at <= now()
       AND (status <> 'draft' OR deleted_at IS NOT NULL OR branch_of IS NOT NULL)`
  );
  const due = await q<{ id: number; title: string; space_id: number; space_name: string }>(
    `UPDATE documents d SET status = 'published', publish_at = NULL, updated_at = now()
     WHERE d.publish_at IS NOT NULL AND d.publish_at <= now()
       AND d.status = 'draft' AND d.deleted_at IS NULL AND d.branch_of IS NULL
     RETURNING d.id, d.title, d.space_id,
       (SELECT name FROM spaces s WHERE s.id = d.space_id) AS space_name`
  );
  for (const doc of due) {
    await audit({
      actor: { name: "system" },
      action: "document.scheduled_publish",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
    });
    try {
      const { notifySpaceSubscribers } = await import("./subscriptions");
      void notifySpaceSubscribers({
        spaceId: doc.space_id,
        spaceName: doc.space_name,
        docId: doc.id,
        title: doc.title,
        kind: "published",
        actorUserId: 0, // no actor to exclude from recipients
        actorName: "Scheduler",
        origin: "", // falls back to the configured custom domain
      });
    } catch (e) {
      console.error("[doc-schedule] subscriber notify failed:", e);
    }
    // Keep search/embeddings fresh for the newly live doc.
    void import("./embeddings").then((m) => m.indexDocument(doc.id)).catch(() => {});
  }

  // Auto-unpublish: published docs only; a stale schedule elsewhere clears.
  await q(
    `UPDATE documents SET archive_at = NULL
     WHERE archive_at IS NOT NULL AND archive_at <= now()
       AND (status <> 'published' OR deleted_at IS NOT NULL OR branch_of IS NOT NULL)`
  );
  const archived = await q<{ id: number; title: string }>(
    `UPDATE documents SET status = 'draft', archive_at = NULL, updated_at = now()
     WHERE archive_at IS NOT NULL AND archive_at <= now()
       AND status = 'published' AND deleted_at IS NULL AND branch_of IS NULL
     RETURNING id, title`
  );
  for (const doc of archived) {
    await audit({
      actor: { name: "system" },
      action: "document.scheduled_unpublish",
      targetType: "document",
      targetId: doc.id,
      targetLabel: doc.title,
    });
  }
}
