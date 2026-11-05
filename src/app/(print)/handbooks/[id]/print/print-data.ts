// The printed handbook's data (1.18.0): one handbook as the reader may see
// it, resolved into the PrintHandbook the sheets render. Server-only.
//
// Access is the handbook's: getHandbook answers only for someone who may
// read it (readers: published and in the audience; editors: any status), and
// "handbook access opens its policies", so each listed document's body is
// read directly here rather than through /doc/{id}'s space checks.

import "server-only";
import { headers } from "next/headers";
import { getHandbook, type Handbook, type HandbookItem, type HandbookUser } from "@/lib/handbooks";
import { getDocumentsByIds, isTrainingDeckDoc } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { getAppSettings } from "@/lib/settings-store";
import { formatDate, settingsForUser } from "@/lib/format";
import { DOC_TYPE_LABEL, type SessionUser } from "@/lib/types";
import type { PaperSize, PrintHandbook, PrintPolicy, PrintSection } from "@/components/handbooks/print/print-model";

/** The paper a workspace prints on unless the reader picks: Letter for US dates, else A4. */
export function defaultPaper(dateFormat: string): PaperSize {
  return dateFormat === "us" ? "letter" : "a4";
}

/** Where the handbook lives: the configured domain, else the request's own origin. */
async function readerUrl(id: number, customDomain: string): Promise<string> {
  if (customDomain) return `https://${customDomain}/handbooks/${id}`;
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost";
  return `${proto}://${host}/handbooks/${id}`;
}

export async function loadPrintHandbook(
  user: SessionUser,
  id: number,
  paper: PaperSize | null
): Promise<{ handbook: Handbook; print: PrintHandbook } | undefined> {
  const handbook = await getHandbook(user as HandbookUser, id);
  if (!handbook) return undefined;

  const [workspace, ackLicensed] = await Promise.all([getAppSettings(), featureEnabled("policy_ack")]);
  const fmt = settingsForUser(workspace, user);

  // Readers are listed only live, published items; the filter holds the
  // line for an editor's view too: a draft is not printed as policy.
  const items: { section: Handbook["sections"][number]; item: HandbookItem }[] = handbook.sections.flatMap((section) =>
    section.items.filter((item) => item.doc_status === "published").map((item) => ({ section, item }))
  );
  const docs = new Map(
    (await getDocumentsByIds(items.map((i) => i.item.doc_id)))
      .filter((d) => !d.deleted_at && d.status === "published")
      .map((d) => [d.id, d])
  );
  const printable = items.filter((i) => docs.has(i.item.doc_id));
  const decks = await Promise.all(printable.map(({ item }) => isTrainingDeckDoc(item.doc_id)));

  // Numbered as printed: a policy left out (unpublished since) does not
  // leave a gap in "Policy k of N".
  const policies: PrintPolicy[] = printable.map(({ item }, i) => {
    const doc = docs.get(item.doc_id)!;
    return {
      docId: doc.id,
      number: i + 1,
      title: doc.title,
      typeLabel: DOC_TYPE_LABEL[doc.type] ?? "Document",
      spaceName: item.space_name,
      // The facts are the item's (lib/handbooks), the same the reader shows.
      version: item.version,
      effectiveLabel: item.effective_at ? formatDate(item.effective_at, fmt) : "",
      owner: item.owner_name,
      appliesTo: (item.applies_to ?? "").trim(),
      summaryPoints: item.summary_points ?? [],
      content: doc.content,
      slideBreaks: decks[i] ? "hidden" : undefined,
    };
  });
  const byDoc = new Map(policies.map((p) => [p.docId, p]));
  // The reader's section numbers, so "2 · Information security" is the same
  // section on screen and on paper.
  const sections: PrintSection[] = handbook.sections.map((s) => ({
    number: s.title.trim() ? s.number : null,
    title: s.title.trim(),
    policies: s.items.map((it) => byDoc.get(it.doc_id)).filter((p): p is PrintPolicy => !!p),
  }));

  const asksToConfirm =
    ackLicensed && handbook.status === "published" && (handbook.confirm_whole || printable.some((p) => p.item.ack_required === 1));

  return {
    handbook,
    print: {
      id: handbook.id,
      title: handbook.title,
      status: handbook.status,
      introduction: handbook.introduction ?? "",
      ownerLabel: handbook.space_id === null ? workspace.company_name : handbook.owner_label,
      company: workspace.company_name,
      logoUrl: workspace.logo_url || "",
      sections,
      policyCount: policies.length,
      sectionCount: sections.filter((s) => s.number !== null && s.policies.length > 0).length,
      printedOn: formatDate(new Date().toISOString(), fmt),
      printedBy: user.name || user.username,
      currentUrl: await readerUrl(handbook.id, workspace.custom_domain),
      confirmOnline: asksToConfirm,
      paper: paper ?? defaultPaper(fmt.date_format),
    },
  };
}
