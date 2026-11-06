// /support/requests/[number]: one of the contact's own requests (Helpdesk
// 1.19.1): status, the answers they gave, the public conversation (agents
// by first name and team; never internal notes, held replies or system
// lines) and the reply box. Someone else's number is a 404. A request an
// agent joined with another (merged) says so and links to the one kept,
// where its conversation now is.

import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Download, GitMerge } from "lucide-react";
import Link from "next/link";
import { chipClass } from "@/components/Chip";
import { contactRequestDetail, currentPortalContact, getPortalSettings, portalOpen } from "@/lib/helpdesk/portal";
import { PortalReply } from "@/components/helpdesk/portal/PortalReply";
import { PortalTime } from "@/components/helpdesk/portal/PortalTime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request" };

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default async function PortalRequest({ params }: { params: Promise<{ number: string }> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const raw = (await params).number;
  const contact = await currentPortalContact(settings);
  if (!contact) redirect(`/support?next=/support/requests/${/^\d{1,10}$/.test(raw) ? raw : ""}`);
  const n = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  const r = n ? await contactRequestDetail(contact, n) : null;
  if (!r) notFound();
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <Link href="/support/requests" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-compass-700 print:hidden">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Your requests
      </Link>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500">
            #{r.number}
            {r.request_type_title && ` · ${r.request_type_title}`} · raised <PortalTime value={r.created_at} />
          </p>
          <h1 className="mt-0.5 break-words text-2xl font-bold text-slate-900">{r.subject}</h1>
        </div>
        <span className={chipClass(r.tone, "md", "shrink-0")}>{r.status_label}</span>
      </div>

      {r.answers.length > 0 && (
        <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-surface p-4 text-sm shadow-xs sm:grid-cols-2">
          {r.answers.map((a, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-xs text-slate-500">{a.label}</dt>
              <dd className="whitespace-pre-line break-words text-slate-800">{a.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <h2 className="sr-only">Conversation</h2>
      <ol className="mt-4 space-y-3">
        {r.messages.map((m) => (
          <li
            key={m.id}
            className={`rounded-xl border border-slate-200 bg-surface p-4 shadow-xs ${m.mine ? "" : "border-l-3 border-l-compass-500"}`}
          >
            <p className="text-xs text-slate-500">
              <span className="font-semibold text-slate-800">{m.author}</span>
              {m.team && ` · ${m.team}`} · <PortalTime value={m.created_at} />
            </p>
            {m.body && <p className="mt-1.5 whitespace-pre-line break-words text-sm text-slate-800">{m.body}</p>}
            {m.attachments.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {m.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={`/support/api/files/${a.id}`} className={chipClass("neutral", "md", "max-w-full hover:bg-slate-200")}>
                      <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{a.name}</span>
                      <span className="text-slate-500">{size(a.size)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      {r.joined_into && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-surface px-4 py-3 text-sm text-slate-800 shadow-xs">
          <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
          <p>
            This request was joined with #{r.joined_into} so one person can help with both. Its conversation is there, and so are replies.{" "}
            <Link href={`/support/requests/${r.joined_into}`} className="link font-medium">
              Open #{r.joined_into}
            </Link>
          </p>
        </div>
      )}

      <div className="mt-5 print:hidden">
        {r.joined_into ? null : r.can_reply ? (
          <PortalReply number={r.number} />
        ) : (
          <p className="rounded-xl border border-slate-200 bg-surface px-4 py-3 text-sm text-slate-500">
            This request is closed. <Link href="/support/new" className="link font-medium">Raise a new one</Link> if you still need help.
          </p>
        )}
      </div>
    </div>
  );
}
