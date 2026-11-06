"use client";

// Solve with a maintenance record (1.19.3; mock-up i4). When Desk settings →
// Assets says "Offer to log a maintenance record" and the ticket has a
// linked Snipe-IT asset, the desk's solve flow (Solve, `e`, the status menu,
// Send and set Solved) first asks here: "Solve #N", the subject, and a card
// "Log a maintenance record in Snipe-IT" (ticked) with the asset(s), Type,
// Supplier (In house, or Snipe-IT's suppliers) and an editable Note that
// starts "CompassDocs #N.". Cancel keeps the ticket open; "Solve and log"
// (or "Solve" with the box unticked) carries on with the solve.
//
// The record is posted only after the solve committed
// (logMaintenanceAfterSolve, POST …/assets/solve); a failure is a toast here
// and an internal note on the ticket, and the ticket stays solved.
//
//   const plan = await askMaintenanceOnSolve(number, subject);
//   if (plan === false) return;            // cancelled, or checklists block it
//   … solve …
//   if (plan) void logMaintenanceAfterSolve(number, plan);
//
// SolveMaintenanceHost is mounted once by the ticket pane; without it the
// solve simply goes ahead with nothing to log.

import { useEffect, useId, useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Field, Select, Textarea } from "@/components/form";
import { toast } from "@/components/Toasts";
import { ASSET_LIMITS, DEFAULT_MAINTENANCE_TYPE, type HdSolveOffer } from "@/lib/helpdesk/assets-shared";
import { getJson, sendJson } from "../api";
import { checklistsHoldSolve } from "../checklists/TicketChecklists";

export interface MaintenancePlan {
  asset_ids: number[];
  type: string;
  supplier_id: number | null;
  note: string;
}

type Ask = { number: number; subject: string; offer: HdSolveOffer; resolve: (v: MaintenancePlan | null | false) => void };

let host: ((a: Ask) => void) | null = null;

/**
 * Before a solve: the plan to log, null when there is nothing to offer (or
 * the agent unticked it), false when the solve should not go ahead.
 */
export async function askMaintenanceOnSolve(number: number, subject: string): Promise<MaintenancePlan | null | false> {
  let offer: HdSolveOffer | null = null;
  try {
    offer = (await getJson<{ offer: HdSolveOffer | null }>(`/api/helpdesk/tickets/${number}/assets/solve`)).offer;
  } catch {
    return null;
  }
  if (!offer || !host) return null;
  // Required checklist items would refuse the solve: say so now, not after the dialog.
  if (await checklistsHoldSolve(number)) return false;
  const h = host;
  return new Promise((resolve) => h({ number, subject, offer: offer!, resolve }));
}

/** After the solve committed: post the record(s). Never throws. */
export async function logMaintenanceAfterSolve(number: number, plan: MaintenancePlan): Promise<void> {
  try {
    const r = await sendJson<{ logged: { tag: string }[]; failed: { tag: string; error: string }[] }>(
      `/api/helpdesk/tickets/${number}/assets/solve`,
      "POST",
      plan,
      "Couldn't log the maintenance record."
    );
    if (r.failed.length) toast("error", `Solved, but the maintenance record wasn't logged: ${r.failed[0].error}`);
    else if (r.logged.length) toast("ok", r.logged.length === 1 ? `Maintenance logged for ${r.logged[0].tag}.` : `Maintenance logged for ${r.logged.length} assets.`);
  } catch (e) {
    toast("error", `Solved, but the maintenance record wasn't logged: ${(e as Error).message}`);
  }
}

export function SolveMaintenanceHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    host = (a) => setAsk(a);
    return () => {
      host = null;
    };
  }, []);
  if (!ask) return null;
  return (
    <SolveMaintenanceDialog
      key={ask.number}
      ask={ask}
      onDone={(v) => {
        ask.resolve(v);
        setAsk(null);
      }}
    />
  );
}

function SolveMaintenanceDialog({ ask, onDone }: { ask: Ask; onDone: (v: MaintenancePlan | null | false) => void }) {
  const { offer } = ask;
  const [log, setLog] = useState(true);
  // A record goes to at most ASSET_LIMITS.perTicket assets. A merge moves every link, so a ticket may hold more.
  const [ids, setIds] = useState<number[]>(offer.assets.slice(0, ASSET_LIMITS.perTicket).map((a) => a.id));
  const [type, setType] = useState(offer.types.some((t) => t.value === DEFAULT_MAINTENANCE_TYPE) ? DEFAULT_MAINTENANCE_TYPE : offer.types[0]?.value ?? "");
  const [supplier, setSupplier] = useState("0");
  const [note, setNote] = useState(offer.note);
  const titleId = useId();
  const checkId = useId();
  const many = offer.assets.length > 1;
  const capped = offer.assets.length > ASSET_LIMITS.perTicket;
  const full = ids.length >= ASSET_LIMITS.perTicket;
  const capId = useId();
  const going = log && ids.length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!going) return onDone(null);
    onDone({ asset_ids: ids, type, supplier_id: Number(supplier) || null, note: note.trim() });
  }

  return (
    <Modal open onClose={() => onDone(false)} labelledBy={titleId} className="w-full max-w-xl rounded-xl border border-slate-200 bg-surface p-6 shadow-modal">
      <form onSubmit={submit} data-testid="solve-maintenance">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <CircleCheck className="h-5 w-5 text-slate-700" aria-hidden />
          Solve #{ask.number}
        </h2>
        <p className="mt-1 text-sm text-slate-600">{ask.subject}</p>

        <div className="mt-4 rounded-xl border border-slate-200 p-4">
          <label htmlFor={checkId} className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-900">
            <input id={checkId} type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} className="h-4 w-4" data-autofocus="" />
            Log a maintenance record in {offer.provider_label}
          </label>
          {many ? (
            <fieldset className="mt-2" disabled={!log}>
              <legend className="sr-only">Assets</legend>
              {offer.assets.map((a) => (
                <label key={a.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={ids.includes(a.id)}
                    aria-disabled={(full && !ids.includes(a.id)) || undefined}
                    aria-describedby={capped ? capId : undefined}
                    onChange={(e) => setIds((cur) => (e.target.checked ? (cur.length >= ASSET_LIMITS.perTicket ? cur : [...cur, a.id]) : cur.filter((x) => x !== a.id)))}
                  />
                  {[a.name, a.tag].filter(Boolean).join(" · ")}
                </label>
              ))}
              {capped && (
                <p id={capId} className="mt-1 text-xs text-slate-500">
                  Choose up to {ASSET_LIMITS.perTicket} assets.
                </p>
              )}
            </fieldset>
          ) : (
            <p className="mt-1 text-sm text-slate-600">{[offer.assets[0].name, offer.assets[0].tag].filter(Boolean).join(" · ")}</p>
          )}
          {log && (
            <>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Type">
                  <Select value={type} onChange={(e) => setType(e.target.value)}>
                    {offer.types.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Supplier">
                  <Select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                    <option value="0">In house</option>
                    {offer.suppliers.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Note" className="mt-3" help="The ticket number is added if you take it out.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={ASSET_LIMITS.note} className="h-20" />
              </Field>
            </>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {going ? "Solve and log" : "Solve"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
