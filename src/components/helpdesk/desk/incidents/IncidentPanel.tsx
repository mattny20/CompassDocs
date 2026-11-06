"use client";

// A major incident's own ticket (1.19.2, agent W1; mock-up a1), in the
// pane's main column above the conversation:
//
//   Updates to everyone affected   each update (time, text, "Ana Kowalski ·
//     sent to 34 requesters and shown in Get help"), then the composer:
//     the update, "Solve the incident and its 34 linked tickets", and Post
//     update. Only for someone who runs incidents in the team.
//   Linked tickets · 34            the linked tickets the agent works (the
//     rest counted), Link tickets, a row's Unlink, and the rule ("New
//     tickets whose subject matches vpn link themselves while the incident
//     is open.") with Edit, and whether linking tells the requester.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Megaphone, Pencil, Plus, Send, Unlink } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { SectionEmpty } from "@/components/form";
import { Modal } from "@/components/Modal";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { HD_STATUS_LABEL, type HdStatus } from "@/lib/helpdesk/types";
import { INCIDENT_LIMITS, ruleTerms, sentLine, type IncidentTicketResult, type IncidentView } from "@/lib/helpdesk/incidents-shared";
import { sendJson } from "../api";
import { useDeskMe } from "../me";
import { useQueue } from "../queue/QueueLayout";
import { askTimeOnSolve } from "../time/TimeCard";
import { incidentsChanged, useTicketIncident } from "./data";

export function IncidentPanel({ number, refreshKey, onChanged }: { number: number; refreshKey?: unknown; onChanged: () => void }) {
  const { data } = useTicketIncident(number, refreshKey);
  if (!data || data.role !== "incident") return null;
  return (
    <>
      <UpdatesCard i={data.incident} onChanged={onChanged} />
      <LinkedCard i={data.incident} onChanged={onChanged} />
    </>
  );
}

/** "10:42" today, the date and time before. */
function useWhen() {
  const fmt = useFormatDate();
  return (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : fmt.dateTime(iso);
  };
}

function UpdatesCard({ i, onChanged }: { i: IncidentView; onChanged: () => void }) {
  const me = useDeskMe();
  const when = useWhen();
  const [body, setBody] = useState("");
  const [solve, setSolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<IncidentTicketResult[] | null>(null);
  useEffect(() => {
    setBody("");
    setSolve(false);
  }, [i.number]);
  const n = i.linked_open;
  const solveLabel = `Solve the incident and its ${n} linked ${n === 1 ? "ticket" : "tickets"}`;

  async function submit() {
    const text = body.trim();
    if (busy || (!text && !solve)) return;
    if (solve) {
      const ok = await confirmDialog({
        title: `Solve #${i.number} and its ${n} linked ${n === 1 ? "ticket" : "tickets"}?`,
        body: `${text ? "Your update goes out first. " : ""}Each ticket is solved as if you solved it: its requester gets the solved email and survey, and any you can't solve stay open, with the reason.`,
        confirmLabel: text ? "Post and solve" : "Solve all",
      });
      if (ok !== true) return;
      // The incident's team may ask for time when a ticket is solved (1.19.1, agent V8).
      if (!(await askTimeOnSolve(i.number, me.id))) return;
    }
    setBusy(true);
    try {
      const r = await sendJson<{
        update: { sent_count: number } | null;
        skipped?: IncidentTicketResult[];
        solve: { results: IncidentTicketResult[]; incident: IncidentTicketResult } | null;
      }>(`/api/helpdesk/incidents/${i.number}/updates`, "POST", { body: text, solve }, "Couldn't post the update.");
      setBody("");
      setSolve(false);
      // Not reached (another team's ticket you can't reply on) and left open, each with the server's reason.
      const missed = r.skipped ?? [];
      const open = r.solve ? [...r.solve.results, r.solve.incident].filter((x) => !x.ok) : [];
      const bad = [...missed, ...open.filter((x) => !missed.some((m) => m.number === x.number))];
      const sent = r.update ? `Update sent to ${r.update.sent_count} ${r.update.sent_count === 1 ? "requester" : "requesters"}.` : "";
      const solved = r.solve ? (r.solve.incident.ok ? " The incident is solved." : " The incident is still open.") : "";
      const tail = [missed.length ? `${missed.length} not reached.` : "", open.length ? `${open.length} left open.` : ""].filter(Boolean).join(" ");
      if (bad.length) toast(r.solve && !r.solve.incident.ok ? "error" : "ok", `${sent}${solved} ${tail}`.trim(), { action: { label: "See why", onClick: () => setLeft(bad) } });
      else toast("ok", `${sent}${solved}`.trim() || "Done.");
      incidentsChanged();
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`inc-updates-${i.number}`} className={`${CARD_CLASS} p-4`} data-testid="incident-updates">
      <h3 id={`inc-updates-${i.number}`} className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
        <Megaphone className="h-3.5 w-3.5" aria-hidden />
        Updates to everyone affected
      </h3>
      {i.updates.length === 0 ? (
        <SectionEmpty className="mt-2">No updates yet. The first one goes to everyone on a linked ticket{i.banner !== "off" ? " and shows in Get help" : ""}.</SectionEmpty>
      ) : (
        <ol className="mt-1">
          {i.updates.map((u) => (
            <li key={u.id} className="mt-3 flex gap-3">
              <span className="w-16 shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums text-slate-500">{when(u.created_at)}</span>
              <div className="min-w-0">
                <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{u.body}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {u.author_name} · {sentLine(u.sent_count, i.banner)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {i.open && i.can_manage ? (
        <div className="mt-4 rounded-lg border border-slate-200 has-[textarea:focus-visible]:outline has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-compass-600 dark:has-[textarea:focus-visible]:outline-compass-300">
          <label htmlFor={`inc-body-${i.number}`} className="sr-only">
            Update to everyone affected
          </label>
          <textarea
            id={`inc-body-${i.number}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            maxLength={INCIDENT_LIMITS.update}
            placeholder="What's happening, and what people should do. It goes to everyone on a linked ticket."
            className="block w-full resize-y rounded-t-lg border-0 bg-transparent px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 frame-input focus:ring-0"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-100 px-3 py-2">
            <label className="flex min-w-0 flex-1 items-start gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={solve} onChange={(e) => setSolve(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600" />
              <span>{solveLabel}</span>
            </label>
            <Button icon={<Send />} busy={busy} disabled={!body.trim() && !solve} onClick={() => void submit()}>
              {body.trim() || !solve ? "Post update" : "Solve all"}
            </Button>
          </div>
        </div>
      ) : i.open && i.manage_note ? (
        <p className="notice-warn mt-4 rounded-lg border px-3 py-2 text-sm">{i.manage_note}</p>
      ) : !i.open ? (
        <p className="mt-4 text-sm text-slate-500">This incident is solved. Reopen its ticket to post again.</p>
      ) : null}
      <LeftOpenDialog list={left} onClose={() => setLeft(null)} />
    </section>
  );
}

function LinkedCard({ i, onChanged }: { i: IncidentView; onChanged: () => void }) {
  const { qs } = useQueue();
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<IncidentTicketResult[] | null>(null);

  async function linkMore() {
    const v = await promptDialog({
      title: `Link tickets to #${i.number}`,
      label: "Ticket numbers",
      placeholder: "1099, 1098, 1097",
      help: "Their requesters hear each update. Each ticket is checked on its own.",
      confirmLabel: "Link tickets",
      validate: (s) => (/^\s*#?\d{1,9}(\s*[,\s]\s*#?\d{1,9})*\s*$/.test(s) ? undefined : "Ticket numbers, separated by commas."),
    });
    if (!v) return;
    const numbers = [...new Set(v.split(/[,\s]+/).filter(Boolean).map((x) => Number(x.replace("#", ""))))].slice(0, INCIDENT_LIMITS.link);
    setBusy(true);
    try {
      const r = await sendJson<{ results: IncidentTicketResult[]; linked: number[] }>(`/api/helpdesk/incidents/${i.number}/links`, "POST", { numbers }, "Couldn't link the tickets.");
      const bad = r.results.filter((x) => !x.ok);
      const lead = r.linked.length === 1 ? "1 ticket linked." : `${r.linked.length} tickets linked.`;
      if (bad.length) toast(r.linked.length ? "ok" : "error", `${r.linked.length ? lead : "Nothing linked."} ${bad.length} skipped.`, { action: { label: "See why", onClick: () => setLeft(bad) } });
      else toast("ok", r.linked.length ? lead : "Already linked.");
      incidentsChanged();
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink(n: number) {
    try {
      await sendJson(`/api/helpdesk/incidents/ticket/${n}`, "DELETE", undefined, "Couldn't unlink the ticket.");
      toast("ok", `#${n} unlinked.`);
      incidentsChanged();
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function patch(p: Record<string, unknown>, ok: string) {
    try {
      await sendJson(`/api/helpdesk/incidents/${i.number}`, "PATCH", p, "Couldn't change the incident.");
      toast("ok", ok);
      incidentsChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function editRule() {
    const v = await promptDialog({
      title: "Link new tickets automatically",
      label: "Subject or description contains",
      initial: i.match_text,
      placeholder: "vpn, remote desktop",
      help: "Up to five words or phrases, separated by commas. Leave it empty to link tickets by hand only.",
      required: false,
      confirmLabel: "Save",
      validate: (s) => (s.length > INCIDENT_LIMITS.match ? `Keep it under ${INCIDENT_LIMITS.match} characters.` : undefined),
    });
    if (v === null) return;
    await patch({ match_text: v }, v.trim() ? "New matching tickets will link themselves." : "New tickets are linked by hand only.");
  }

  const terms = ruleTerms(i.match_text);
  return (
    <section aria-labelledby={`inc-linked-${i.number}`} className={`${CARD_CLASS} p-4`} data-testid="incident-linked">
      <div className="flex items-center gap-2">
        <h3 id={`inc-linked-${i.number}`} className={EYEBROW_TEXT}>
          Linked tickets · {i.linked_total}
        </h3>
        {i.open && i.can_link && (
          <Button variant="secondary" size="sm" icon={<Plus />} busy={busy} className="ml-auto" onClick={() => void linkMore()}>
            Link tickets
          </Button>
        )}
      </div>
      {i.linked.length === 0 ? (
        <SectionEmpty className="mt-2">
          {i.hidden ? `${i.hidden} linked ${i.hidden === 1 ? "ticket is" : "tickets are"} in teams you don't work.` : "No tickets linked yet. Link them here, or from a ticket's … menu."}
        </SectionEmpty>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Tickets linked to #{i.number}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Subject</th>
                <th scope="col">Requester</th>
                <th scope="col">Linked</th>
                <th scope="col" className="relative">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {i.linked.map((r) => (
                <tr key={r.number} className="group">
                  <td className="whitespace-nowrap py-2 pr-3 align-top tabular-nums">
                    <Link href={`/desk/tickets/${r.number}${qs}`} className="link">
                      #{r.number}
                    </Link>
                  </td>
                  <td className="min-w-0 py-2 pr-3 align-top text-slate-800">
                    {r.subject}
                    {r.status !== "new" && r.status !== "open" && <span className="ml-1.5 text-xs text-slate-500">· {HD_STATUS_LABEL[r.status as HdStatus] ?? r.status}</span>}
                  </td>
                  <td className="hidden py-2 pr-3 align-top text-slate-600 sm:table-cell">{r.requester_name}</td>
                  <td className="whitespace-nowrap py-2 pr-1 align-top text-xs text-slate-500">
                    <RelativeTime value={r.linked_at} />
                    {r.via === "rule" && <span className="sr-only"> by the rule</span>}
                  </td>
                  <td className="w-8 py-1.5 text-right align-top">
                    {i.can_link && (
                      <button
                        type="button"
                        onClick={() => void unlink(r.number)}
                        aria-label={`Unlink #${r.number}`}
                        data-tt="Unlink"
                        className={iconButtonClass("quiet", "sm", "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 print:hidden")}
                      >
                        <Unlink aria-hidden />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {i.hidden > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              And {i.hidden} in {i.hidden === 1 ? "a team" : "teams"} you don&apos;t work.
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex items-start gap-2 text-sm text-slate-600">
        <p className="min-w-0 flex-1">
          {terms.length ? (
            <>
              New tickets whose subject or description matches{" "}
              {terms.map((t, k) => (
                <span key={t}>
                  {k > 0 && (k === terms.length - 1 ? " or " : ", ")}
                  <code className="rounded bg-slate-100 px-1 py-px text-[0.8125rem] text-slate-800">{t}</code>
                </span>
              ))}{" "}
              link themselves while the incident is open.
            </>
          ) : (
            "New tickets are linked by hand."
          )}
        </p>
        {i.can_manage && i.open && (
          <button type="button" onClick={() => void editRule()} aria-label="Edit the rule" data-tt="Edit the rule" className={iconButtonClass("quiet", "sm", "-my-1")}>
            <Pencil aria-hidden />
          </button>
        )}
      </div>
      {i.can_manage && i.open && (
        <label className="mt-2 flex items-start gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={i.notify_on_link}
            onChange={(e) => void patch({ notify_on_link: e.target.checked }, e.target.checked ? "Requesters hear when their ticket is linked." : "Linking is quiet; updates still go out.")}
            className="mt-0.5 h-4 w-4 shrink-0 accent-compass-600"
          />
          <span>Tell requesters when their ticket is linked</span>
        </label>
      )}
      <LeftOpenDialog list={left} onClose={() => setLeft(null)} title="skipped" />
    </section>
  );
}

/** "See why": each ticket left as it was and the server's reason. */
export function LeftOpenDialog({ list, onClose, title = "not changed" }: { list: IncidentTicketResult[] | null; onClose: () => void; title?: "not changed" | "skipped" }) {
  return (
    <Modal
      open={!!list}
      onClose={onClose}
      labelledBy="inc-left-title"
      className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id="inc-left-title" className="text-base font-semibold text-slate-900">
        {list?.length === 1 ? `1 ticket ${title}` : `${list?.length ?? 0} tickets ${title}`}
      </h2>
      <p className="mt-1 text-sm text-slate-600">Each ticket is checked on its own, as if you changed it by hand. These weren&apos;t changed:</p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {(list ?? []).map((r) => (
          <li key={r.number} className="px-3 py-2">
            <span className="block text-sm font-medium text-slate-800">#{r.number}</span>
            <span className="block text-xs text-slate-600">{r.error}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose} data-autofocus="">
          Close
        </Button>
      </div>
    </Modal>
  );
}
