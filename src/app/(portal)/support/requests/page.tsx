// /support/requests: Your requests (Helpdesk 1.19.1, mock #13). The
// signed-in contact's own requests, newest activity first, each a link with
// its status chip. Not signed in: the sign-in page, coming back here.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { currentPortalContact, getPortalSettings, listContactRequests, offeredTypes, portalOpen } from "@/lib/helpdesk/portal";
import { PortalTime } from "@/components/helpdesk/portal/PortalTime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your requests" };

export default async function PortalRequests() {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const contact = await currentPortalContact(settings);
  if (!contact) redirect("/support?next=/support/requests");
  const [rows, types] = await Promise.all([listContactRequests(contact.id), offeredTypes(settings)]);
  const canRaise = types.length > 0;
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Your requests</h1>
        {canRaise && (
          <Button href="/support/new" icon={<Plus />} className="ml-auto">
            New request
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-surface px-5 py-8 text-center shadow-xs">
          <p className="text-sm font-medium text-slate-800">No requests yet</p>
          <p className="mt-1 text-sm text-slate-500">
            {canRaise ? "When you raise a request, you can follow it here." : "There's nothing you can raise here at the moment."}
          </p>
          {canRaise && (
            <Button href="/support/new" variant="secondary" className="mt-4">
              Raise a request
            </Button>
          )}
        </div>
      ) : (
        <ul className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" aria-label="Your requests">
          {rows.map((r) => (
            <li key={r.number} className="border-b border-slate-100 last:border-b-0">
              <Link href={`/support/requests/${r.number}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-slate-900">{r.subject}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    #{r.number}
                    {r.request_type_title && ` · ${r.request_type_title}`}
                    <span className="hidden sm:inline">
                      {" "}· updated <PortalTime value={r.updated_at} />
                    </span>
                  </span>
                </span>
                <span className={chipClass(r.tone, "md", "shrink-0")}>{r.status_label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
