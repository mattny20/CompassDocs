import { cache } from "react";
import { notFound } from "next/navigation";
import { BookOpen, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { userHolds } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { getHandbook, handbookKind, handbookTypeCounts, kindNoun } from "@/lib/handbooks";
import { loadConfirmView } from "@/lib/handbook-confirm";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { LicenseGate } from "@/components/LicenseGate";
import { EmptyState } from "@/components/form";
import { HandbookConfirm } from "@/components/handbooks/confirm/HandbookConfirm";

export const dynamic = "force-dynamic";

// Confirm the whole handbook (1.18.0, policy_ack): every policy in the
// handbook with where it stands for the reader, the statement, the typed
// signature when one is asked, and one button that confirms every policy
// still waiting (lib/handbook-confirm). A handbook the reader cannot read,
// or a draft, is the shell's not-found page; one that does not ask for a
// whole-handbook confirmation says so with a way back.
//
// The column is the mock-up's 44rem: a form read top to bottom, inside
// the user's page width (a deliberate content column, not a page width).

/** "One confirmation covers every policy below…"; "every SOP", "every document" for other contents (1.18.2). */
const subtitleFor = (noun: string) =>
  `One confirmation covers every ${noun} below that is waiting for you. Each is recorded against the version you read, as if you had confirmed it on its own page.`;

const handbookFor = cache(async (id: number) => {
  const user = await requireUser();
  return { user, handbook: Number.isInteger(id) && id > 0 ? await getHandbook(user, id) : undefined };
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { handbook } = await handbookFor(Number((await params).id));
  return { title: handbook ? `Confirm · ${handbook.title}` : "Handbook" };
}

export default async function ConfirmHandbookPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const { user, handbook } = await handbookFor(id);
  if (!handbook || handbook.status !== "published") notFound();

  const crumbs = (
    <Breadcrumbs
      items={[
        { href: "/handbooks", label: "Handbooks" },
        { href: `/handbooks/${handbook.id}`, label: handbook.title, title: handbook.title },
      ]}
      className="mb-2"
    />
  );
  const kind = handbookKind(handbookTypeCounts(handbook.sections.flatMap((s) => s.items)));
  const noun = kindNoun(kind);
  const header = <PageHeader icon={<ShieldCheck />} title="Confirm the handbook" subtitle={subtitleFor(noun)} />;

  if (!(await featureEnabled("policy_ack"))) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-176">
          {crumbs}
          {header}
          <LicenseGate
            feature="Read confirmation"
            entitlement="policy_ack"
            canManage={await userHolds(user, "workspace.settings_read", { legacyMin: "admin" })}
          />
        </div>
      </PageContainer>
    );
  }

  const view = await loadConfirmView(user, handbook.id);
  if (!view) notFound();

  return (
    <PageContainer>
      <div className="mx-auto max-w-176">
        {crumbs}
        {header}
        {view.handbook.confirm_whole ? (
          <HandbookConfirm view={view} readerName={user.name || user.username} />
        ) : (
          <EmptyState
            icon={<BookOpen />}
            title="This handbook doesn't ask for a confirmation"
            body={`Read it, and confirm any ${kindNoun(kind)} that asks you to on its own page.`}
            action={{ href: `/handbooks/${handbook.id}`, label: "Open the handbook", icon: <BookOpen /> }}
          />
        )}
      </div>
    </PageContainer>
  );
}
