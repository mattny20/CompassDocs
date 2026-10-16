import { notFound } from "next/navigation";
import {
  getDocument,
  listSpaces,
  getApprovalMode,
  listAllSpaceCategories,
  isTrainingDeckDoc,
  ackSummary,
} from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { canPublishDirectly, spaceScopeFor, scopeAllows, canEditSpace, editableScopeFor } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { featureEnabled } from "@/lib/ee";
import { DocEditor } from "@/components/DocEditor";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return { title: doc?.title ? `Edit · ${doc.title}` : "Edit document" };
}

export default async function EditDocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("editor", "document.update");
  const { id } = await params;
  const doc = await cachedDocument(Number(id));
  if (!doc) notFound();
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, doc.space_id)) notFound();
  if (!(await canEditSpace(user, doc.space_id))) notFound();
  // The move-to-space dropdown only offers spaces the user can author in.
  const spaces = await listSpaces(await editableScopeFor(user));
  const spaceIds = new Set(spaces.map((s) => s.id));
  const categories = (await listAllSpaceCategories()).filter(
    (c) => spaceIds.has(c.space_id) || c.space_id === doc.space_id
  );
  const canPublish = await canPublishDirectly(user, doc.space_id);
  const settings = await getAppSettings();
  // Read confirmation (A3): a confirmed document tells the editor so a save
  // that changes its text can ask how readers should see the change. The
  // counts come from the one summary statement (never names); the confirmed
  // baseline text is fetched by the editor only when a save needs it.
  const ackActive =
    doc.ack_required === 1 && doc.branch_of === null && (await featureEnabled("policy_ack"));
  const ack = ackActive ? await ackSummary(doc.id, {}) : null;

  return (
    <DocEditor
      mode="edit"
      canPublish={canPublish}
      spaces={spaces}
      categories={categories}
      nestedEnabled={settings.nested_pages_enabled && doc.branch_of === null}
      docLinks={settings.backlinks_enabled}
      trainingDeck={await isTrainingDeckDoc(doc.id)}
      initial={{
        id: doc.id,
        space_id: doc.space_id,
        category_id: doc.category_id,
        parent_id: doc.parent_id,
        title: doc.title,
        type: doc.type,
        status: doc.status,
        summary: doc.summary,
        tags: doc.tags,
        content: doc.content,
        author: doc.author,
        publish_at: doc.publish_at ?? null,
        archive_at: doc.archive_at ?? null,
        updated_at: doc.updated_at,
        ack: ack
          ? {
              required: ack.required,
              editDefault: ack.edit_default,
              summary: {
                eligible: ack.eligible,
                current: ack.current,
                pending: ack.pending,
                version_id: ack.version_id,
                rev: ack.rev,
                latest_version_id: ack.latest_version_id,
                latest_rev: ack.latest_rev,
              },
            }
          : undefined,
      }}
    />
  );
}
