// /support: the customer portal's home (Helpdesk 1.19.1, mock #13).
// With the help centre on (1.19.4, C3, mock h1) it is the help centre for
// everyone, signed in or not; the sign-in form then answers at
// /support?signin=1 and wherever a page sends someone to sign in
// (?next=…, ?expired=1). With it off, the home is the sign-in as before.
// Signed in already, on the sign-in form: straight to ?next, else to Your
// requests.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cleanNextPath, currentPortalContact, getPortalSettings, offeredTypes, portalOpen } from "@/lib/helpdesk/portal";
import { getHelpCentreSettings, helpCentreCategories, helpCentreOpen } from "@/lib/helpdesk/help-centre";
import { PortalSignIn } from "@/components/helpdesk/portal/PortalSignIn";
import { HelpCentreHome } from "@/components/helpdesk/portal/help/HelpCentre";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

/** The help centre home, rather than the sign-in form. */
function wantsHome(sp: SP): boolean {
  return sp.next === undefined && sp.signin === undefined && sp.expired === undefined;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  try {
    const sp = await searchParams;
    const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
    if (wantsHome(sp) && (await helpCentreOpen({ hc, portal }))) {
      return { title: "Help centre", robots: hc.indexing ? { index: true, follow: true } : { index: false, follow: false, nocache: true } };
    }
  } catch {
    /* no database: the layout's defaults */
  }
  return { title: "Sign in" };
}

export default async function PortalHome({ searchParams }: { searchParams: Promise<SP> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const sp = await searchParams;
  const hc = await getHelpCentreSettings();
  if (wantsHome(sp) && (await helpCentreOpen({ hc, portal: settings }))) {
    const [categories, types] = await Promise.all([helpCentreCategories({ hc, portal: settings }), offeredTypes(settings)]);
    return <HelpCentreHome categories={categories} canRaise={types.length > 0} />;
  }
  const next = cleanNextPath(typeof sp.next === "string" ? sp.next : "");
  if (await currentPortalContact(settings)) redirect(next || "/support/requests");
  return <PortalSignIn next={next} />;
}
