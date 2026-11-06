// /support: the customer portal's sign-in (Helpdesk 1.19.1, mock #13).
// Signed in already: straight to Your requests. ?next= (a portal path)
// is where the link will land; ?expired=1 says the last link was spent.

import { notFound, redirect } from "next/navigation";
import { cleanNextPath, currentPortalContact, getPortalSettings, portalOpen } from "@/lib/helpdesk/portal";
import { PortalSignIn } from "@/components/helpdesk/portal/PortalSignIn";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const sp = await searchParams;
  const next = cleanNextPath(typeof sp.next === "string" ? sp.next : "");
  if (await currentPortalContact(settings)) redirect(next || "/support/requests");
  return <PortalSignIn next={next} />;
}
