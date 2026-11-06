// The customer portal's frame (Helpdesk 1.19.1, agent V6): people outside
// the organisation, with no CompassDocs account. Deliberately outside the
// (app) route group: no app session is read, no sidebar, no link into the
// app; a branded header (the portal's logo and name from Desk settings,
// Customer portal) and, when signed in, the address and Sign out. Never
// indexed, and no Referer leaves a portal page (sign-in links carry a token).
// When the portal is off or unlicensed the pages answer 404 (support/
// not-found) and this frame shows no brand.

import type { Metadata } from "next";
import { currentPortalContact, getPortalSettings, portalBrand, portalOpen } from "@/lib/helpdesk/portal";
import { PortalHeader } from "@/components/helpdesk/portal/PortalHeader";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  let name = "Support";
  try {
    const s = await getPortalSettings();
    if (await portalOpen(s)) name = (await portalBrand(s)).name;
  } catch {
    /* no database: keep the plain name */
  }
  return {
    title: { absolute: name, template: `%s · ${name}` },
    description: `Raise and follow your requests with ${name}.`,
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
    manifest: null,
    appleWebApp: null,
  };
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const settings = await getPortalSettings();
  const open = await portalOpen(settings);
  const brand = open ? await portalBrand(settings) : null;
  const contact = open ? await currentPortalContact(settings) : null;
  return (
    <div className="min-h-screen bg-canvas text-slate-700">
      {brand && <PortalHeader name={brand.name} logoUrl={brand.logo_url} email={contact?.email ?? null} />}
      <main id="main" className="px-4 pb-16 sm:px-6">
        {children}
      </main>
    </div>
  );
}
