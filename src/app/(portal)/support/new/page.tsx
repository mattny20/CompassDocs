// /support/new: raise a request in the customer portal (Helpdesk 1.19.1).
// Only the request types the admin exposed that need nothing from the
// directory; their own questions, never prefilled. ?type=<id> preselects.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { currentPortalContact, getPortalSettings, offeredTypes, portalOpen } from "@/lib/helpdesk/portal";
import { PortalNewRequest } from "@/components/helpdesk/portal/PortalNewRequest";

export const dynamic = "force-dynamic";
export const metadata = { title: "New request" };

export default async function PortalNew({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const contact = await currentPortalContact(settings);
  if (!contact) redirect("/support?next=/support/new");
  const types = await offeredTypes(settings);
  const sp = await searchParams;
  const initial = typeof sp.type === "string" && /^\d+$/.test(sp.type) ? Number(sp.type) : null;
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <Link href="/support/requests" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-compass-700">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Your requests
      </Link>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">New request</h1>
      <p className="mt-1 text-sm text-slate-500">Tell us what you need. We&apos;ll email you when there&apos;s a reply.</p>
      <div className="mt-5">
        {types.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-surface px-4 py-6 text-sm text-slate-500">There&apos;s nothing you can raise here at the moment.</p>
        ) : (
          <PortalNewRequest
            types={types.map((t) => ({ id: t.id, title: t.title, description: t.description, eta_label: t.eta_label, form: t.form }))}
            askName={!contact.name}
            initialType={initial}
          />
        )}
      </div>
    </div>
  );
}
