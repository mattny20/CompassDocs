"use client";

// A ticket in the recycle bin, opened by link or from the bin (1.19.4, area
// C7; mock-up v3): a red banner ("This ticket is in the recycle bin. Ana
// Kowalski deleted it today at 14:02. It's deleted for good on 6 Dec unless
// it's restored.") with Restore for roles holding tickets.delete, then the
// ticket itself, read-only: its header and conversation, dimmed and inert
// (no composer, no status menu, no side panel). Every write route answers
// 404 for a binned ticket anyway. GET /api/helpdesk/recycle-bin/[number].
// Requesters, approvers and CCs never reach it: their routes answer 404.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Inbox, Lock, LockOpen, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { binBannerText, type HdBinnedInfo } from "@/lib/helpdesk/recycle-bin-shared";
import type { HdTicketDetail } from "@/lib/helpdesk/types";
import { ApiError, getJson, sendJson } from "../api";
import { useCan, useDeskMe } from "../me";
import { Conversation } from "../ticket/Conversation";
import { binRequest } from "./actions";

export function BinnedTicketPane({
  number,
  back,
  onRestored,
  restoredHref,
}: {
  number: number;
  back?: { href: string; label: string };
  onRestored?: () => void;
  /** Where Restore goes (default: the ticket in the queue). */
  restoredHref?: string;
}) {
  const me = useDeskMe();
  const can = useCan();
  const router = useRouter();
  const [data, setData] = useState<{ detail: HdTicketDetail; bin: HdBinnedInfo } | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getJson<{ detail: HdTicketDetail; bin: HdBinnedInfo }>(`/api/helpdesk/recycle-bin/${number}`, "Couldn't load that ticket.")
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }));
  }, [number]);

  useEffect(() => {
    setData(null);
    setError(null);
    load();
  }, [load]);

  // A legal hold can be placed on a binned ticket (settings.manage): the purge then skips it.
  async function hold(on: boolean) {
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/tickets/${number}/legal-hold`, "PUT", { on }, "Couldn't change the legal hold.");
      toast("ok", on ? `#${number} is on legal hold. It won't be deleted for good while the hold is on.` : `#${number} is off legal hold.`);
      load();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    try {
      const [r] = await binRequest("restore", [number]);
      if (!r?.ok) {
        toast("error", r?.error ?? "Couldn't restore the ticket.");
        return;
      }
      toast("ok", `#${number} restored.`);
      onRestored?.();
      router.push(restoredHref ?? `/desk/tickets/${number}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const backLink = back && (
    <Link href={back.href} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {back.label}
    </Link>
  );

  if (error) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {backLink}
        <PageHeader className="sr-only" title={`Ticket #${number}`} />
        <EmptyState
          icon={error.status === 404 ? <Inbox /> : <TriangleAlert />}
          title={error.status === 404 ? `#${number} isn't in the recycle bin` : "Couldn't load this ticket"}
          body={error.status === 404 ? "It may have been restored or deleted for good, or it belongs to a team you're not in." : error.message}
          action={error.status === 404 ? { href: "/desk/recycle-bin", label: "Open the recycle bin" } : { onClick: load, label: "Try again" }}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-w-0 flex-1 p-6" aria-busy>
        <PageHeader className="sr-only" title={`Ticket #${number}`} />
        <LoadingRow className="py-16" />
      </div>
    );
  }

  const { detail: d, bin } = data;
  const t = d.ticket;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <article aria-labelledby="binned-subject" className="px-4 py-4 sm:px-6 sm:py-5">
        {backLink}
        <PageHeader className="sr-only" title={`Ticket #${t.number}: ${t.subject} (in the recycle bin)`} />
        <div role="status" className="notice-error flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm" data-testid="binned-banner">
          <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            <b>This ticket is in the recycle bin.</b> {binBannerText(bin)}
          </p>
          <div className="flex flex-wrap gap-2">
            {can("settings.manage") && (
              <Button variant="secondary" icon={bin.legal_hold ? <LockOpen /> : <Lock />} disabled={busy} onClick={() => void hold(!bin.legal_hold)}>
                {bin.legal_hold ? "Lift legal hold" : "Place legal hold"}
              </Button>
            )}
            {bin.can_restore && (
              <Button variant="secondary" icon={<Undo2 />} busy={busy} onClick={() => void restore()}>
                Restore
              </Button>
            )}
          </div>
        </div>
        {/* Read-only: dimmed, out of the tab order and the accessibility tree's controls. */}
        <div className="mt-5 opacity-60 print:opacity-100" inert>
          <p className="text-xs text-slate-500">
            #{t.number}
            {t.team_name && ` · ${t.team_name}`} · opened <RelativeTime value={t.created_at} /> by {t.requester_name || t.requester_email}
          </p>
          <h2 id="binned-subject" className="mt-1 text-xl font-bold text-slate-900">
            {t.subject}
          </h2>
          <div className="mt-4 max-w-3xl">
            <Conversation messages={d.messages} requesterId={t.requester_id} meId={me.id} ticketNumber={t.number} origins={d.merge?.message_origins} />
          </div>
        </div>
      </article>
    </div>
  );
}
