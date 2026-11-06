"use client";

// The top of a ticket's pane when it is part of a major incident (1.19.2,
// agent W1; mock-up a1). The incident's own ticket: a notice-error strip,
// "Major incident · declared by Ana Kowalski 48m ago · 34 tickets linked ·
// shown in Get help" (neutral once solved). A linked ticket: a neutral
// strip naming the incident (a link when the agent works its ticket), that
// its requester hears the updates, and Unlink.

import Link from "next/link";
import { useState } from "react";
import { Link2, Siren, Unlink } from "lucide-react";
import { Button } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { sendJson } from "../api";
import { useQueue } from "../queue/QueueLayout";
import { incidentsChanged, useTicketIncident } from "./data";

export function IncidentBanner({ number, refreshKey }: { number: number; refreshKey?: unknown }) {
  const { data } = useTicketIncident(number, refreshKey);
  const { qs, refresh } = useQueue();
  const [busy, setBusy] = useState(false);
  if (!data || data.role === null) return null;

  if (data.role === "incident") {
    const i = data.incident;
    const linked = `${i.linked_total} ${i.linked_total === 1 ? "ticket" : "tickets"} linked`;
    const shown = i.open && i.banner !== "off" ? " · shown in Get help" : "";
    return (
      <div
        data-testid="incident-banner"
        className={`mb-3 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${i.open ? "notice-error" : "border-slate-200 bg-slate-50 text-slate-700"}`}
      >
        <Siren className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0">
          <b className="font-semibold">{i.open ? "Major incident" : "Major incident, solved"}</b> · declared by {i.declared_by_name || "someone"}{" "}
          <RelativeTime value={i.declared_at} /> · {linked}
          {shown}
        </p>
      </div>
    );
  }

  const l = data.link;
  async function unlink() {
    const ok = await confirmDialog({
      title: `Unlink #${number} from #${l.incident.number}?`,
      body: "Its requester stops hearing the incident's updates, and solving the incident leaves this ticket open.",
      confirmLabel: "Unlink",
    });
    if (ok !== true) return;
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/incidents/ticket/${number}`, "DELETE", undefined, "Couldn't unlink the ticket.");
      toast("ok", `#${number} unlinked from #${l.incident.number}.`);
      incidentsChanged();
      refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const name = (
    <>
      #{l.incident.number} {l.incident.title}
    </>
  );
  return (
    <div data-testid="incident-link-strip" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <Link2 className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <p className="min-w-0 flex-1">
        Linked to major incident{" "}
        {l.can_open ? (
          <Link href={`/desk/tickets/${l.incident.number}${qs}`} className="link font-medium">
            {name}
          </Link>
        ) : (
          <b className="font-medium">{name}</b>
        )}
        {l.incident.open ? " · its updates reach this requester" : " · solved"}
      </p>
      {l.can_unlink && (
        <Button variant="ghost" size="sm" icon={<Unlink />} busy={busy} onClick={() => void unlink()}>
          Unlink
        </Button>
      )}
    </div>
  );
}
