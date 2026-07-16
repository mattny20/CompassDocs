import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listNewslettersFor } from "@/lib/db";
import { canUseNewsletter, isNewsletterApprover } from "@/lib/newsletter-access";
import { PageContainer } from "@/components/PageWidth";
import { NewsletterList } from "@/components/NewsletterList";

export const dynamic = "force-dynamic";

// The newsletter workspace: contributors see their own pieces plus the sent
// history; approvers and admins see everything.
export default async function NewsletterPage() {
  const user = await requireUser();
  if (!canUseNewsletter(user)) redirect("/");

  const rows = await listNewslettersFor(user.id, isNewsletterApprover(user));
  return (
    <PageContainer>
      <NewsletterList
        initial={rows.map((r) => ({
          id: r.id,
          subject: r.subject,
          author_name: r.author_name,
          status: r.status,
          audience: r.audience,
          sent_count: r.sent_count,
          updated_at: String(r.updated_at),
          sent_at: r.sent_at ? String(r.sent_at) : null,
          scheduled_at: r.scheduled_at ? String(r.scheduled_at) : null,
        }))}
      />
    </PageContainer>
  );
}
