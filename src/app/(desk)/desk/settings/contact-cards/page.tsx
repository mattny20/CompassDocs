// /desk/settings/contact-cards: Contact cards (desk settings, Helpdesk
// 1.19.0, agent O). Which directory fields fill a contact card, the chat
// apps, VIPs and who sees what. Opens for a desk role holding
// settings.manage (the API checks the same).

import { requireUser } from "@/lib/auth";
import { hdCan } from "@/lib/helpdesk/roles";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ContactCardsSettings } from "@/components/helpdesk/contacts/ContactCardsSettings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contact cards" };

export default async function Page() {
  const user = await requireUser();
  if (!(await hdCan(user, "settings.manage").catch(() => false))) return <DeskPageForbidden what="Contact cards" />;
  return <ContactCardsSettings />;
}
