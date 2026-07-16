import { requireRole } from "@/lib/auth";
import { listUsers } from "@/lib/db";
import { listNewsletterFromAddresses } from "@/lib/newsletter";
import { NewsletterPeople } from "@/components/NewsletterPeople";

export const dynamic = "force-dynamic";

// Settings → Newsletter is the access roster + sender list; writing and
// sending happens in the /newsletter workspace (linked from the roster).
export default async function NewsletterAdminPage() {
  await requireRole("admin");
  const [users, senders] = await Promise.all([listUsers(), listNewsletterFromAddresses()]);
  return (
    <NewsletterPeople
      initialSenders={senders}
      initial={users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
        newsletter_role: u.newsletter_role,
      }))}
    />
  );
}
