import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  listNewsletterComments,
  listNewsletterApproverPool,
  listGroups,
} from "@/lib/db";
import {
  canUseNewsletter,
  canView,
  canEditContent,
  canSubmit,
  canDecide,
  canSend,
  canComment,
  canDelete,
} from "@/lib/newsletter-access";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { listNewsletterFromAddresses } from "@/lib/newsletter";
import { PageContainer } from "@/components/PageWidth";
import { NewsletterWorkspace } from "@/components/NewsletterWorkspace";

export const dynamic = "force-dynamic";

export default async function NewsletterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const hasModuleAccess = canUseNewsletter(user);
  const home = hasModuleAccess ? "/newsletter" : "/";

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) redirect(home);
  const approverIds = await getNewsletterApproverIds(n.id);
  // Sent newsletters are readable by every signed-in user (the dashboard
  // links here); everything unsent stays with the editorial crew.
  if (!canView(user, n, approverIds)) redirect(home);

  const [comments, groups, pool, smtp, fromAddresses] = await Promise.all([
    hasModuleAccess ? listNewsletterComments(n.id) : Promise.resolve([]),
    listGroups(),
    listNewsletterApproverPool(),
    getSmtpConfig(),
    listNewsletterFromAddresses(),
  ]);

  return (
    <PageContainer>
      <NewsletterWorkspace
        initial={{
          newsletter: {
            ...n,
            created_at: String(n.created_at),
            updated_at: String(n.updated_at),
            sent_at: n.sent_at ? String(n.sent_at) : null,
          } as any,
          comments: comments.map((c) => ({
            id: c.id,
            author_name: c.author_name,
            body: c.body,
            kind: c.kind,
            created_at: String(c.created_at),
          })),
          approver_ids: approverIds,
          can: {
            edit: canEditContent(user, n, approverIds),
            submit: canSubmit(user, n),
            decide: canDecide(user, n, approverIds),
            send: canSend(user, n, approverIds),
            comment: canComment(user, n, approverIds),
            delete: canDelete(user, n),
          },
        }}
        groups={groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count }))}
        approverPool={pool}
        smtpReady={smtpConfigured(smtp)}
        fromAddresses={fromAddresses}
        hasModuleAccess={hasModuleAccess}
      />
    </PageContainer>
  );
}
