"use client";

// Declare a major incident (1.19.2, agent W1; mock-up a2). One dialog on
// the house Modal, opened from the queue's bulk bar (the selected tickets)
// or a ticket's … menu (that ticket). It opens a new ticket for the outage
// and links the chosen tickets to it: the title people will see, the team
// that runs it and its priority, the tickets to link (a radio card, as the
// mock-up has it), the words that link new tickets while it is open, and
// two switches: the Get help banner with "Me too", and telling the linked
// tickets' requesters by email. Refusals show one line per ticket.
//
// From the Status page (1.19.2, agent W6, `fromStatus`; mock-up s3): the
// desk's status pop-up and team queue banner open it prefilled from a
// service (title, team, auto-link words), with "Link the N open tickets
// that mention …" in place of the selection and "Solve the incident's
// tickets when … is operational again (asks first)", recorded through
// POST /api/helpdesk/team-status/incident once declared.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Siren } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { controlClass, FormError, Select } from "@/components/form";
import { toast } from "@/components/Toasts";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority } from "@/lib/helpdesk/types";
import { INCIDENT_LIMITS, listTicketNumbers, type IncidentRefusal } from "@/lib/helpdesk/incidents-shared";
import { useDeskCounts } from "../counts";
import { useQueue } from "../queue/QueueLayout";
import { incidentsChanged } from "./data";
import { sendJson } from "../api";
import { useClock } from "../team-status/clock";
import type { DeclarePrefill } from "@/lib/helpdesk/status-teams-shared";

export interface DeclareTicket {
  number: number;
  subject?: string;
  team_id?: number | null;
}

export function DeclareIncidentDialog({
  open,
  onClose,
  tickets,
  fromTicket = false,
  fromStatus,
  onDeclared,
}: {
  open: boolean;
  onClose: () => void;
  /** The tickets to link (the selection, or the ticket the menu was opened on). */
  tickets: DeclareTicket[];
  fromTicket?: boolean;
  /** Started from a Status page service (agent W6): prefilled, and the service recorded on the incident. */
  fromStatus?: DeclarePrefill;
  onDeclared?: (number: number) => void;
}) {
  const router = useRouter();
  const { qs, refresh } = useQueue();
  const { counts } = useDeskCounts();
  const teams = counts?.teams ?? [];
  const [title, setTitle] = useState("");
  const [team, setTeam] = useState<number | "">("");
  const [priority, setPriority] = useState<HdPriority>("urgent");
  const [match, setMatch] = useState("");
  const [banner, setBanner] = useState(true);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refusals, setRefusals] = useState<IncidentRefusal[]>([]);
  const [linkFound, setLinkFound] = useState(true);
  const [askSolve, setAskSolve] = useState(true);
  const clock = useClock();

  useEffect(() => {
    if (!open) return;
    setTitle(fromTicket && tickets[0]?.subject ? tickets[0].subject.slice(0, INCIDENT_LIMITS.title) : "");
    const first = tickets.find((t) => t.team_id && teams.some((x) => x.team_id === t.team_id))?.team_id;
    setTeam(first ?? teams[0]?.team_id ?? "");
    setPriority("urgent");
    setMatch("");
    setBanner(true);
    setNotify(true);
    setError("");
    setRefusals([]);
    setBusy(false);
    if (fromStatus) {
      setTitle(fromStatus.title.slice(0, INCIDENT_LIMITS.title));
      setTeam(fromStatus.team_id);
      setMatch(fromStatus.words.join(", "));
      setLinkFound(true);
      setAskSolve(true);
    }
    // Open-time defaults only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The desk's team counts may land after the dialog opened: default the team then.
  useEffect(() => {
    if (!open || team !== "" || !teams.length) return;
    const first = tickets.find((t) => t.team_id && teams.some((x) => x.team_id === t.team_id))?.team_id;
    setTeam(first ?? teams[0].team_id);
  }, [open, team, teams, tickets]);

  const n = tickets.length;
  const found = fromStatus?.tickets ?? [];
  const linkNumbers = fromStatus ? (linkFound ? found.map((t) => t.number) : []) : tickets.map((t) => t.number);
  const ready = title.trim().length > 0 && team !== "";

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    setRefusals([]);
    try {
      // A plain fetch: a refusal carries one reason per ticket (refusals[]).
      const res = await fetch("/api/helpdesk/incidents", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          team_id: team,
          priority,
          numbers: linkNumbers,
          match_text: match.trim(),
          banner: banner ? "workspace" : "off",
          notify_on_link: notify,
        }),
      });
      const r = (await res.json().catch(() => ({}))) as { number?: number; linked?: number[]; error?: string; refusals?: IncidentRefusal[] };
      if (!res.ok || !r.number) {
        setError(r.error || "Couldn't declare the incident.");
        setRefusals(Array.isArray(r.refusals) ? r.refusals : []);
        return;
      }
      toast("ok", r.linked?.length ? `Major incident #${r.number} declared, with ${listTicketNumbers(r.linked)} linked.` : `Major incident #${r.number} declared.`);
      if (fromStatus) {
        await sendJson("/api/helpdesk/team-status/incident", "POST", { number: r.number, service_id: fromStatus.service.id, ask_solve: askSolve }, "The incident is declared, but its Status page service wasn't recorded.").catch((e: Error) =>
          toast("error", e.message)
        );
      }
      incidentsChanged();
      refresh();
      onDeclared?.(r.number);
      router.push(`/desk/tickets/${r.number}${qs}`);
    } catch {
      setError("Couldn't declare the incident. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="declare-title"
      describedBy="declare-lede"
      className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="declare-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Siren className="h-5 w-5 text-slate-700" aria-hidden />
          Declare a major incident
        </h2>
        <p id="declare-lede" className="mt-1 text-sm text-slate-600">
          {fromStatus
            ? `Started from the Status page: ${fromStatus.service.name} ${fromStatus.service.state === "outage" ? "is down" : fromStatus.service.state === "degraded" ? "is degraded" : "had trouble"}.`
            : "One ticket for the outage. Everyone on a linked ticket hears each update, and Get help shows a banner."}
        </p>

        <label htmlFor="declare-name" className="mt-5 block text-sm font-medium text-slate-800">
          Title people will see
        </label>
        <input
          id="declare-name"
          data-autofocus=""
          value={title}
          maxLength={INCIDENT_LIMITS.title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="VPN is down from home"
          className={controlClass(false, "mt-1")}
          autoComplete="off"
        />

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="declare-team" className="block text-sm font-medium text-slate-800">
              Team
            </label>
            <Select id="declare-team" className="mt-1" value={team} onChange={(e) => setTeam(e.target.value ? Number(e.target.value) : "")}>
              {teams.length === 0 && <option value="">No teams</option>}
              {teams.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="declare-priority" className="block text-sm font-medium text-slate-800">
              Priority
            </label>
            <Select id="declare-priority" className="mt-1" value={priority} onChange={(e) => setPriority(e.target.value as HdPriority)}>
              {HD_PRIORITIES.slice()
                .reverse()
                .map((p) => (
                  <option key={p} value={p}>
                    {HD_PRIORITY_LABEL[p]}
                  </option>
                ))}
            </Select>
          </div>
        </div>

        {n > 0 && !fromStatus && (
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-slate-800">Link</legend>
            <label className="mt-1 flex cursor-pointer gap-3 rounded-lg border border-compass-300 bg-compass-50/60 p-3">
              <input type="radio" name="declare-link" checked readOnly className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-800">
                  {fromTicket ? `This ticket` : n === 1 ? "The selected ticket" : `The ${n} selected tickets`}
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-500">
                  {fromTicket && tickets[0]?.subject ? `#${tickets[0].number} ${tickets[0].subject}` : tickets.map((t) => `#${t.number}`).join(", ")}
                </span>
              </span>
            </label>
          </fieldset>
        )}

        <label htmlFor="declare-match" className="mt-4 block text-sm font-medium text-slate-800">
          Link new tickets automatically while it&apos;s open
        </label>
        <div className={controlClass(false, "mt-1 flex items-center gap-1.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-compass-600 dark:has-[:focus-visible]:outline-compass-300")}>
          <span className="shrink-0 text-slate-500" aria-hidden>
            Subject or description contains:
          </span>
          <input
            id="declare-match"
            value={match}
            maxLength={INCIDENT_LIMITS.match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder="vpn"
            aria-describedby="declare-match-help"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-slate-800 placeholder:text-slate-400 frame-input focus:ring-0"
            autoComplete="off"
          />
        </div>
        <p id="declare-match-help" className="mt-1 text-xs text-slate-500">
          Up to five words, separated by commas. Leave it empty to link tickets by hand.
        </p>

        <div className="mt-4 space-y-2.5 text-sm text-slate-700">
          {fromStatus && found.length > 0 && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={linkFound} onChange={(e) => setLinkFound(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
              <span>
                Link the {found.length === 1 ? "open ticket" : `${found.length} open tickets`} that {found.length === 1 ? "mentions" : "mention"} {fromStatus.words[0]} since {clock(fromStatus.since)}
              </span>
            </label>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={banner} onChange={(e) => setBanner(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
            <span>Show a banner in Get help with a &ldquo;Me too&rdquo; button</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
            <span>Tell the requesters of linked tickets by email</span>
          </label>
          {fromStatus && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={askSolve} onChange={(e) => setAskSolve(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
              <span>Solve the incident&apos;s tickets when {fromStatus.service.name} is operational again (asks first)</span>
            </label>
          )}
        </div>

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

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" icon={<Siren />} busy={busy} disabled={!ready}>
            Declare incident
          </Button>
        </div>
      </form>
    </Modal>
  );
}
