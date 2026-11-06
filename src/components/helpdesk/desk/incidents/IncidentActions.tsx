"use client";

// Major incident actions on a ticket and on a queue selection (1.19.2,
// agent W1):
//
//   useIncidentMenu(ticket)   the ticket's … menu items "Declare a major
//     incident…" (incidents.manage) and "Link to a major incident…"
//     (incidents.link), with their dialogs. Neither shows on an incident's
//     own ticket, a linked one (its strip has Unlink), a closed or merged
//     one, or a workflow task.
//   DeclareFromSelection      the bulk bar's "Declare incident…".
//   LinkToIncidentDialog      the open incidents as radio cards; Link.

import { useState, type ReactNode } from "react";
import { Link2, Siren } from "lucide-react";
import { Button } from "@/components/Button";
import { MenuItem } from "@/components/Popover";
import { Modal } from "@/components/Modal";
import { FormError, SectionEmpty } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import type { HdTicketListRow } from "@/lib/helpdesk/types";
import type { IncidentTicketResult } from "@/lib/helpdesk/incidents-shared";
import { sendJson } from "../api";
import { useCan } from "../me";
import { useQueue } from "../queue/QueueLayout";
import { incidentsChanged, useOpenIncidents, useTicketIncident } from "./data";
import { DeclareIncidentDialog } from "./DeclareIncidentDialog";

interface TicketLike {
  number: number;
  subject: string;
  team_id: number | null;
  status: string;
  merged_into?: number | null;
  parent_ticket_id?: number | null;
  source?: string;
}

/** The … menu's incident items and their dialogs; `any` says whether there are items. */
export function useIncidentMenu(t: TicketLike): { any: boolean; items: (close: () => void) => ReactNode; dialogs: ReactNode } {
  const can = useCan();
  const { data } = useTicketIncident(t.number);
  const [declaring, setDeclaring] = useState(false);
  const [linking, setLinking] = useState(false);
  const eligible = data?.role === null && t.status !== "closed" && !t.merged_into && !t.parent_ticket_id && t.source !== "workflow";
  const canDeclare = eligible && can("incidents.manage");
  const canLink = eligible && can("incidents.link");
  return {
    any: canDeclare || canLink,
    items: (close) => (
      <>
        {canDeclare && (
          <MenuItem icon={<Siren />} onClick={() => { close(); setDeclaring(true); }}>
            Declare a major incident…
          </MenuItem>
        )}
        {canLink && (
          <MenuItem icon={<Link2 />} onClick={() => { close(); setLinking(true); }}>
            Link to a major incident…
          </MenuItem>
        )}
      </>
    ),
    dialogs: (
      <>
        {canDeclare && <DeclareIncidentDialog open={declaring} onClose={() => setDeclaring(false)} tickets={[t]} fromTicket onDeclared={() => setDeclaring(false)} />}
        {canLink && <LinkToIncidentDialog open={linking} onClose={() => setLinking(false)} number={t.number} />}
      </>
    ),
  };
}

/** The bulk bar's "Declare incident…": the selected tickets are linked to it. */
export function DeclareFromSelection({ rows, busy, onDone }: { rows: HdTicketListRow[]; busy: boolean; onDone: () => void }) {
  const can = useCan();
  const [open, setOpen] = useState(false);
  if (!can("incidents.manage") || rows.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Siren />} disabled={busy} onClick={() => setOpen(true)}>
        Declare incident…
      </Button>
      <DeclareIncidentDialog
        open={open}
        onClose={() => setOpen(false)}
        tickets={rows.map((r) => ({ number: r.number, subject: r.subject, team_id: r.team_id }))}
        onDeclared={() => {
          setOpen(false);
          onDone();
        }}
      />
    </>
  );
}

/** Link one ticket to an open incident (the ticket's … menu). */
export function LinkToIncidentDialog({ open, onClose, number }: { open: boolean; onClose: () => void; number: number }) {
  const list = useOpenIncidents("link", open);
  const { refresh } = useQueue();
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = pick ?? list?.[0]?.number ?? null;

  async function submit() {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ results: IncidentTicketResult[] }>(`/api/helpdesk/incidents/${chosen}/links`, "POST", { numbers: [number] }, "Couldn't link the ticket.");
      const mine = r.results.find((x) => x.number === number);
      if (mine && !mine.ok) {
        setError(mine.error ?? "Couldn't link the ticket.");
        return;
      }
      toast("ok", `#${number} linked to major incident #${chosen}.`);
      incidentsChanged();
      refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="link-inc-title"
      className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id="link-inc-title" className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Link2 className="h-4.5 w-4.5 text-slate-700" aria-hidden />
        Link #{number} to a major incident
      </h2>
      <p className="mt-1 text-sm text-slate-600">Its requester hears each update, and solving the incident solves it too.</p>
      {list === null ? (
        <LoadingRow className="py-6" />
      ) : list.length === 0 ? (
        <SectionEmpty className="mt-4">No major incident is open. Declare one from this ticket&apos;s … menu.</SectionEmpty>
      ) : (
        <div role="radiogroup" aria-label="The incident" className="mt-4 space-y-2">
          {list.map((i) => {
            const on = i.number === chosen;
            return (
              <label key={i.id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${on ? "border-compass-300 bg-compass-50/60" : "border-slate-200 hover:bg-slate-50"}`}>
                <input
                  type="radio"
                  name="link-inc"
                  checked={on}
                  onChange={() => setPick(i.number)}
                  data-autofocus={on ? "" : undefined}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">
                    #{i.number} {i.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {[i.team_name, `${i.linked_open} open linked`].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      <FormError className="mt-3">{error}</FormError>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button icon={<Link2 />} busy={busy} disabled={!chosen} onClick={() => void submit()}>
          {chosen ? `Link to #${chosen}` : "Link"}
        </Button>
      </div>
    </Modal>
  );
}
