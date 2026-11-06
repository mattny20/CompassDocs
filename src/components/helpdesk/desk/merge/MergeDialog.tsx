"use client";

// Merge tickets (1.19.1, agent V2; mock-up #2). One dialog on the house
// Modal, opened from the queue's bulk bar ("Merge…", two or more selected)
// or from a ticket's "…" menu ("Merge into another ticket…", which first
// finds the other ticket). The agent picks the ticket to keep from stacked
// radio cards (the oldest is chosen first); a "What happens" card says
// what the server will do; "Tell the requesters" previews the note they
// get. The primary says what it does ("Merge into #1049"). The server's
// refusals (a workflow, another team, an earlier merge) show under the
// cards with the ticket each one is about.

import { useEffect, useMemo, useRef, useState } from "react";
import { GitMerge, Search } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { EYEBROW_TEXT } from "@/components/Heading";
import { controlClass, FormError, SectionEmpty } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { HD_STATUS_LABEL, type HdTicketListRow } from "@/lib/helpdesk/types";
import { listNames, listNumbers, mergedNote, MERGE_MAX } from "@/lib/helpdesk/merge-shared";
import { getJson, listOf } from "../api";
import { compactDue } from "../ui";

export type MergeCandidate = Pick<
  HdTicketListRow,
  "number" | "subject" | "requester_id" | "requester_name" | "status" | "created_at" | "due_label" | "sla_state"
>;

interface Refusal {
  number: number;
  reason: string;
}

export function MergeDialog({
  open,
  onClose,
  tickets,
  findOther,
  onMerged,
}: {
  open: boolean;
  onClose: () => void;
  /** The tickets to merge (the bulk bar's selection), or the one ticket the "…" menu was opened on. */
  tickets: MergeCandidate[];
  /** From a ticket: find the other ticket first. */
  findOther?: boolean;
  onMerged: (keep: number, merged: number[]) => void;
}) {
  const [picked, setPicked] = useState<MergeCandidate | null>(null);
  // Oldest first, as the conversations will read once merged.
  const all = useMemo(
    () =>
      (picked ? [picked, ...tickets.filter((t) => t.number !== picked.number)] : [...tickets]).sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number
      ),
    [tickets, picked]
  );
  const oldest = useMemo(
    () => (all.length ? all.reduce((a, b) => (Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b)).number : null),
    [all]
  );
  const [keep, setKeep] = useState<number | null>(null);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refusals, setRefusals] = useState<Refusal[]>([]);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setNotify(true);
    setError("");
    setRefusals([]);
    setBusy(false);
  }, [open]);
  // From a ticket the found one is kept by default; from the queue, the oldest.
  useEffect(() => setKeep(findOther && picked ? picked.number : oldest), [oldest, picked, findOther]);

  const keepT = all.find((t) => t.number === keep) ?? null;
  const others = all.filter((t) => t.number !== keep);
  const ccNames = [...new Set(others.filter((t) => t.requester_name && (t.requester_id === null || t.requester_id !== keepT?.requester_id)).map((t) => t.requester_name))];
  const ready = !!keepT && others.length > 0 && others.length <= MERGE_MAX;

  async function submit() {
    if (!ready || !keepT || busy) return;
    setBusy(true);
    setError("");
    setRefusals([]);
    try {
      // A plain fetch: a refusal carries one reason per ticket (refusals[]).
      const res = await fetch("/api/helpdesk/tickets/merge", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ keep: keepT.number, merge: others.map((t) => t.number), notify }),
      });
      const r = (await res.json().catch(() => ({}))) as { keep?: number; merged?: number[]; already?: boolean; error?: string; refusals?: Refusal[] };
      if (!res.ok) {
        setError(r.error || "Couldn't merge the tickets.");
        setRefusals(Array.isArray(r.refusals) ? r.refusals : []);
        return;
      }
      const kept = r.keep ?? keepT.number;
      toast("ok", r.already ? `Already merged into #${kept}.` : `Merged ${listNumbers(r.merged ?? [])} into #${kept}.`);
      onMerged(kept, r.merged ?? []);
    } catch {
      setError("Couldn't merge the tickets. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const title = findOther && !picked ? `Merge #${tickets[0]?.number} into another ticket` : `Merge ${all.length} tickets`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="merge-title"
      describedBy="merge-lede"
      className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id="merge-title" className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <GitMerge className="h-4.5 w-4.5 text-slate-700" aria-hidden />
        {title}
      </h2>
      <p id="merge-lede" className="mt-1 text-sm text-slate-600">
        Pick the ticket to keep. The others close as merged, with a link to it, and their messages, attachments and people move across.
      </p>

      {findOther && <TicketFinder exclude={tickets.map((t) => t.number)} picked={picked} onPick={setPicked} />}

      {all.length > 1 && (
        <div
          role="radiogroup"
          aria-label="The ticket to keep"
          className="mt-4 space-y-2"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        >
          {all.map((t) => {
            const checked = t.number === keep;
            const id = `merge-keep-${t.number}`;
            const sla = t.sla_state === "breached" && t.due_label ? `SLA ${compactDue(t.due_label).toLowerCase()}` : "";
            const facts = [t.requester_name, HD_STATUS_LABEL[t.status], t.number === oldest && all.length > 1 ? "oldest" : "", sla].filter(Boolean);
            return (
              <label
                key={t.number}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                  checked ? "border-compass-300 bg-compass-50/60" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <input
                  type="radio"
                  name="merge-keep"
                  checked={checked}
                  onChange={() => setKeep(t.number)}
                  aria-labelledby={`${id}-l`}
                  aria-describedby={`${id}-d`}
                  data-autofocus={checked ? "" : undefined}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600"
                />
                <span className="min-w-0">
                  <span id={`${id}-l`} className="block text-sm font-medium text-slate-800">
                    #{t.number} {t.subject}
                  </span>
                  <span id={`${id}-d`} className="mt-0.5 block text-xs text-slate-500">
                    {facts.join(" · ")}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {ready && keepT && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-canvas px-4 py-3">
          <h3 className={EYEBROW_TEXT}>What happens</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>#{keepT.number} keeps its number, SLA and assignee; the conversations appear in it in time order.</li>
            {ccNames.length > 0 && (
              <li>
                {listNames(ccNames)} {ccNames.length === 1 ? "is" : "are"} added as {ccNames.length === 1 ? "a CC" : "CCs"} on #{keepT.number}.
              </li>
            )}
            <li>
              {listNumbers(others.map((t) => t.number))} close{others.length === 1 ? "s" : ""} as <b className="font-semibold">Merged into #{keepT.number}</b>.
            </li>
          </ul>
        </div>
      )}

      {ready && keepT && (
        <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
          <span>
            Tell the requesters, with a link to #{keepT.number}
            <span className="mt-0.5 block text-xs text-slate-500">&ldquo;{mergedNote(keepT.number)}&rdquo;</span>
          </span>
        </label>
      )}

      <FormError className="mt-3">
        {error && (
          <>
            {error}
            {refusals.length > 1 && (
              <ul className="mt-1 list-disc pl-5">
                {refusals.map((r) => (
                  <li key={r.number}>{r.reason}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </FormError>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button icon={<GitMerge />} busy={busy} disabled={!ready} onClick={() => void submit()}>
          {keepT && ready ? `Merge into #${keepT.number}` : "Merge"}
        </Button>
      </div>
    </Modal>
  );
}

/** "Merge into another ticket…": a search over the agent's queues (any status but closed). */
function TicketFinder({ exclude, picked, onPick }: { exclude: number[]; picked: MergeCandidate | null; onPick: (t: MergeCandidate | null) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MergeCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // A stable key: the caller passes a fresh array each render.
  const skip = exclude.join(",");

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRows(null);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const id = setTimeout(() => {
      getJson(`/api/helpdesk/tickets?view=all&q=${encodeURIComponent(term)}&limit=8&sort=updated`, "Couldn't search the tickets.")
        .then((d) => {
          if (n !== seq.current) return;
          const out = new Set(skip.split(",").map(Number));
          setRows(listOf<HdTicketListRow>(d, "tickets", "rows").filter((t) => !out.has(t.number) && t.status !== "closed" && !t.in_workflow));
        })
        .catch(() => n === seq.current && setRows([]))
        .finally(() => n === seq.current && setLoading(false));
    }, 200);
    return () => clearTimeout(id);
  }, [q, skip]);

  if (picked) {
    return (
      <p className="mt-3 text-sm text-slate-600">
        With #{picked.number} {picked.subject}.{" "}
        <button type="button" className="link" onClick={() => onPick(null)}>
          Choose another
        </button>
      </p>
    );
  }
  return (
    <div className="mt-4">
      <label htmlFor="merge-find" className="block text-sm font-medium text-slate-800">
        The other ticket
      </label>
      <div className="relative mt-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          id="merge-find"
          data-autofocus=""
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Number, subject or requester"
          autoComplete="off"
          className={controlClass(false, "pl-8")}
          aria-describedby="merge-find-help"
        />
      </div>
      <p id="merge-find-help" className="mt-1 text-xs text-slate-500">
        Tickets in your queues; closed ones can&apos;t be merged into.
      </p>
      {loading && !rows && <Spinner size="sm" className="mt-2" label="Searching" />}
      {rows && rows.length === 0 && <SectionEmpty className="mt-2">No open ticket matches that.</SectionEmpty>}
      {rows && rows.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label="Matching tickets">
          {rows.map((t) => (
            <li key={t.number}>
              <button type="button" onClick={() => onPick(t)} className="block w-full px-3 py-2 text-left hover:bg-slate-50">
                <span className="block truncate text-sm font-medium text-slate-800">
                  #{t.number} {t.subject}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {t.requester_name} · {HD_STATUS_LABEL[t.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
