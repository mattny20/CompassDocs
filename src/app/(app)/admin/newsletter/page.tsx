import { requireSettingsSection } from "@/lib/auth";
import { listUsers } from "@/lib/db";
import { listNewsletterFromAddresses, getNewsletterAppearance } from "@/lib/newsletter";
import { NewsletterPeople } from "@/components/NewsletterPeople";
import { SettingsPage } from "@/components/SettingsPage";

export const dynamic = "force-dynamic";

// Settings → Newsletter is the access roster + sender list + email
// appearance; writing and sending happens in the /newsletter workspace.
export default async function NewsletterAdminPage() {
  await requireSettingsSection("/admin/newsletter");
  const [users, senders, appearance] = await Promise.all([
    listUsers(),
    listNewsletterFromAddresses(),
    getNewsletterAppearance(),
  ]);
  return (
    <SettingsPage href="/admin/newsletter">
    <NewsletterPeople
      initialSenders={senders}
      initialAppearance={appearance}
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
    </SettingsPage>
  );
}
