// Scheduled publish / auto-unpublish. Documents carry two one-shot
// timestamps: publish_at (a draft goes live at that time) and archive_at (a
// published doc returns to draft). The minute tick claims due rows with a
// single atomic UPDATE — safe across concurrent app instances — then sends
// the same notifications a manual publish would. Server-only.

import "server-only";
import { pool, resetAcknowledgements } from "./db";
import { audit, auditAckDecision } from "./audit";
import { changeSummary, suggestReconfirm } from "./diff";

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

/** A row the publish claim returns: what the decision below needs to know. */
interface DuePublish {
  id: number;
  title: string;
  content: string;
  space_id: number;
  space_name: string;
  ack_required: number;
  ack_version_id: number | null;
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
  const due = await q<DuePublish>(
    `UPDATE documents d SET status = 'published', publish_at = NULL, updated_at = now()
     WHERE d.publish_at IS NOT NULL AND d.publish_at <= now()
       AND d.status = 'draft' AND d.deleted_at IS NULL AND d.branch_of IS NULL
     RETURNING d.id, d.title, d.content, d.space_id, d.ack_required, d.ack_version_id,
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
    await decideConfirmationsOnScheduledPublish(doc);
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
  // The confirmation marker is untouched: a status flip without a text change
  // never asks anyone (A2), and the decision is taken when the draft is
  // published again, by a person or by the claim above.
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

/** The ledger's actor for a decision nobody took: no id, no name (the History page says "Automatic"). */
const SCHEDULER = { id: null, name: "" } as const;

/**
 * A scheduled publish is the publish transition updateDocument decides at
 * (A2, rule 2): while a required document was a draft its marker stayed on
 * the version people confirmed, so when the draft's title or text drifted
 * from that version the old confirmations must not count for the new text.
 * Nobody is there to ask, so, like merge, restore and bulk in 1.10.0, the
 * scheduler resets (source 'schedule'); with the requirement off the marker
 * follows the text silently (rule 3). Unchanged text asks nobody, and a
 * document without a marker version has nothing to compare against.
 *
 * The claim is already committed when this runs, so the decision is its own
 * short transaction right after it; a failure is logged and the publish
 * stands (the next edit or a manual ask repairs the marker).
 */
async function decideConfirmationsOnScheduledPublish(doc: DuePublish): Promise<void> {
  if (doc.ack_version_id == null) return;
  const baseline = (
    await q<{ title: string; content: string }>(
      "SELECT title, content FROM doc_versions WHERE id = $1 AND document_id = $2",
      [doc.ack_version_id, doc.id]
    )
  )[0];
  if (!baseline || (baseline.title === doc.title && baseline.content === doc.content)) return;
  const latest =
    (await q<{ id: number | null }>("SELECT MAX(id) AS id FROM doc_versions WHERE document_id = $1", [doc.id]))[0]
      ?.id ?? null;
  if (latest == null) return;

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (doc.ack_required !== 1) {
      await resetAcknowledgements(client, doc.id, {
        versionId: latest,
        actor: SCHEDULER,
        source: "schedule",
        reason: "",
        silent: true,
      });
      await client.query("COMMIT");
      return;
    }
    const summary = changeSummary(baseline.content, doc.content, {
      oldTitle: baseline.title,
      newTitle: doc.title,
    });
    const r = await resetAcknowledgements(client, doc.id, {
      versionId: latest,
      actor: SCHEDULER,
      source: "schedule",
      reason: "Published on schedule",
      summary,
      suggested: suggestReconfirm(summary).policy,
    });
    await client.query("COMMIT");
    await auditAckDecision(
      { ack_required: 1 },
      {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        status: "published",
        ack_outcome: {
          changed: true,
          substantive: true,
          reset: true,
          confirmations_reset: r.confirmations_reset,
          policy: "auto",
          source: "schedule",
          decision_id: r.decision_id,
        },
      },
      { actor: { name: "system" } }
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[doc-schedule] re-confirmation decision failed:", e);
  } finally {
    client.release();
  }
}
