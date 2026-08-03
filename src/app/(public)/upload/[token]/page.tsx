// The drop page behind a request_upload link.
//
// One job: take a picture from a person who has it and put it on one document.
// Standalone like the share page — no app shell, no navigation — because the
// person opening it is often not signed in on this device, and may not have an
// account at all. Always noindex.

import type { Metadata } from "next";
import { getUploadTicket, ticketState } from "@/lib/image-intake";
import { getDocument } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { Brand } from "@/components/Brand";
import { UploadDrop } from "@/components/UploadDrop";
import { Link2Off } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add an image",
  robots: { index: false, follow: false },
};

const DEAD_LINK: Record<"unknown" | "expired" | "used", { title: string; body: string }> = {
  unknown: {
    title: "This link isn't valid",
    body: "It may have been mistyped or copied incompletely. Ask for a new one.",
  },
  expired: {
    title: "This link has expired",
    body: "Drop links last an hour. Ask for a new one and it will work straight away.",
  },
  used: {
    title: "This link has already been used",
    body: "Each link accepts one image, once. Ask for a new one to add another.",
  },
};

export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const settings = await getAppSettings();
  const ticket = await getUploadTicket(token);
  const state = ticketState(ticket);
  const doc = ticket ? await getDocument(ticket.document_id) : undefined;
  const dead = DEAD_LINK[state === "ok" ? "unknown" : state];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-6 py-4">
          <Brand name={settings.company_name} logoUrl={settings.logo_url || undefined} />
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Add an image
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10">
        {state === "ok" && doc ? (
          <UploadDrop token={token} docTitle={doc.title} maxMb={settings.max_attachment_mb} />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-xs">
            <Link2Off className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
            <h1 className="mt-3 text-lg font-semibold text-slate-900">{dead.title}</h1>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{dead.body}</p>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-slate-400">
          {settings.company_name} · CompassDocs
        </p>
      </main>
    </div>
  );
}
