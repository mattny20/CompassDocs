import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { settingsForUser } from "@/lib/format";
import { HandbookReader } from "@/components/handbooks/reader/HandbookReader";
import { PolicyPage } from "@/components/handbooks/reader/PolicyPage";
import {
  loadPolicyView,
  loadReaderBase,
  readerCanEdit,
  readerPolicy,
} from "@/components/handbooks/reader/reader-data";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; docId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, docId } = await params;
  const policy = await readerPolicy(Number(id), Number(docId)).catch(() => undefined);
  return { title: policy ? `${policy.document.title} · ${policy.handbook.title}` : "Handbook" };
}

// One policy in the handbook reader (1.18.0): /handbooks/{id}/{docId}, one
// address per policy so it can be bookmarked, shared and opened from the
// confirm page. Reading it needs only the handbook: getHandbookPolicy
// answers for a published handbook the person reads (or one they edit)
// that holds this live, published document, and the policy is rendered
// here, so /doc/{id} keeps its own space check. Anything else is a 404,
// exactly like a document the person may not open.
export default async function HandbookPolicyPage({ params }: Params) {
  const user = await requireUser();
  const { id, docId } = await params;
  const policy = await readerPolicy(Number(id), Number(docId));
  if (!policy) notFound();

  const settings = settingsForUser(await getAppSettings(), user);
  const [base, canEdit] = await Promise.all([
    loadReaderBase(user, policy.handbook, settings),
    readerCanEdit(policy.handbook.id),
  ]);
  const view = await loadPolicyView(user, base, policy, settings);

  return (
    <HandbookReader
      base={base}
      activeDocId={view.docId}
      activeHasInShort={view.summaryPoints.some((p) => p.trim() !== "")}
      canEdit={canEdit}
    >
      <PolicyPage view={view} />
    </HandbookReader>
  );
}
