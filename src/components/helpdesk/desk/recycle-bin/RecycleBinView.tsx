"use client";

// /desk/recycle-bin (1.19.4, area C7; mock-up v2): deleted tickets from the
// teams this person may delete in (tickets.delete), newest first, for 30
// days. Search and a team filter; per row the ticket (opening its read-only
// view), team, who deleted it ("Retention rule" for a system delete), when,
// and the days left, plus Restore; the checkboxes give a bulk Restore and,
// with tickets.purge, "Delete for good…" (a typed confirmation: it can't be
// undone). GET/POST /api/helpdesk/recycle-bin.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Trash2, Undo2 } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { EmptyState, SectionEmpty, TextInput } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { BIN_DAYS, binDaysLeftLabel, binWhenLabel, type HdBinRow } from "@/lib/helpdesk/recycle-bin-shared";
import { getJson } from "../api";
import { useDeskCounts } from "../counts";
import { PickMenu } from "../PickMenu";
import { BIN_CHANGED, binRequest } from "./actions";

interface BinList {
  rows: HdBinRow[];
  total: number;
  can_purge: boolean;
}

export function RecycleBinView() {
  const { counts, refresh: refreshCounts } = useDeskCounts();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState<number>(0);
  const [list, setList] = useState<BinList | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const all = useRef<HTMLInputElement>(null);

  // The search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    const sp = new URLSearchParams();
    if (query) sp.set("q", query);
    if (team) sp.set("team", String(team));
    getJson<BinList>(`/api/helpdesk/recycle-bin?${sp}`, "Couldn't load the recycle bin.")
      .then((r) => {
        setList(r);
        setError("");
        // Rows that left the list leave the selection.
        setPicked((p) => new Set([...p].filter((n) => r.rows.some((x) => x.number === n))));
      })
      .catch((e: Error) => setError(e.message));
  }, [query, team]);

  useEffect(() => {
    load();
    window.addEventListener(BIN_CHANGED, load);
    return () => window.removeEventListener(BIN_CHANGED, load);
  }, [load]);

  const rows = list?.rows ?? [];
  const n = picked.size;
  const allOn = rows.length > 0 && n === rows.length;
  useEffect(() => {
    if (all.current) all.current.indeterminate = n > 0 && !allOn;
  });

  const toggle = (num: number) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });

  async function restore(numbers: number[]) {
    if (!numbers.length || busy) return;
    setBusy(numbers.length === 1 ? `r${numbers[0]}` : "restore");
    try {
      const res = await binRequest("restore", numbers);
      const ok = res.filter((r) => r.ok);
      const bad = res.filter((r) => !r.ok);
      if (ok.length) {
        const what = ok.length === 1 ? `#${ok[0].number} restored.` : `${ok.length} tickets restored.`;
        toast("ok", bad.length ? `${what} ${bad.length} couldn't be: ${bad[0].error}` : what, {
          action: ok.length === 1 ? { label: "Open", onClick: () => window.location.assign(`/desk/tickets/${ok[0].number}`) } : undefined,
        });
      } else toast("error", bad[0]?.error ?? "Nothing was restored.");
      refreshCounts();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function purge(numbers: number[]) {
    if (!numbers.length || busy) return;
    const one = numbers.length === 1;
    const ok = await confirmDialog({
      title: one ? `Delete #${numbers[0]} for good?` : `Delete ${numbers.length} tickets for good?`,
      body: `${one ? "Its" : "Their"} conversation, notes and attachments are removed now instead of after ${BIN_DAYS} days. The audit log keeps the number and subject. This cannot be undone.`,
      confirmLabel: one ? "Delete for good" : `Delete ${numbers.length} for good`,
      danger: true,
      typeToConfirm: "DELETE",
    });
    if (ok !== true) return;
    setBusy("purge");
    try {
      const res = await binRequest("purge", numbers);
      const gone = res.filter((r) => r.ok).length;
      const bad = res.filter((r) => !r.ok);
      if (gone) toast("ok", `${gone === 1 ? "1 ticket" : `${gone} tickets`} deleted for good.${bad.length ? ` ${bad.length} stayed: ${bad[0].error}` : ""}`);
      else toast("error", bad[0]?.error ?? "Nothing was deleted.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const teams = counts?.teams ?? [];
  const teamLabel = team ? teams.find((t) => t.team_id === team)?.name ?? "Team" : "all";
  const filtered = !!query || !!team;

  return (
    <PageContainer>
      <PageHeader
        icon={<Trash2 />}
        title="Recycle bin"
        subtitle={`Deleted tickets stay here for ${BIN_DAYS} days, then they're deleted for good. Restoring puts a ticket back exactly as it was.`}
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {list === null && !error && <LoadingRow className="py-10" />}
      {list && list.total === 0 && !filtered ? (
        <EmptyState
          icon={<Trash2 />}
          title="The recycle bin is empty"
          body={`Tickets you delete wait here for ${BIN_DAYS} days, so you can restore them, before they're deleted for good.`}
          action={{ href: "/desk", label: "Back to the queue" }}
        />
      ) : (
        list && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <TextInput value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search deleted tickets" placeholder="Search deleted tickets" autoComplete="off" spellCheck={false} className="pl-9" />
              </div>
              {teams.length > 1 && (
                <PickMenu
                  label="Team"
                  value={team}
                  align="start"
                  options={[{ value: 0, label: "All teams" }, ...teams.map((t) => ({ value: t.team_id, label: t.name }))]}
                  onPick={(v) => setTeam(v)}
                  trigger={(p) => (
                    <button {...p} type="button" className={buttonClass("secondary", "md", "gap-1")}>
                      Team: {teamLabel}
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                />
              )}
              <span className="hidden flex-1 sm:block" />
              {n > 0 && (
                <div className="flex flex-wrap items-center gap-2" role="region" aria-label="Selected deleted tickets">
                  <span className="text-sm font-semibold text-compass-800" aria-live="polite">
                    {n} selected
                  </span>
                  <Button variant="secondary" icon={<Undo2 />} busy={busy === "restore"} disabled={!!busy} onClick={() => void restore([...picked])}>
                    Restore
                  </Button>
                  {list.can_purge && (
                    <Button variant="danger" busy={busy === "purge"} disabled={!!busy} onClick={() => void purge([...picked])}>
                      Delete for good…
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-card">
              {rows.length === 0 ? (
                <SectionEmpty className="px-4 py-6">No deleted tickets match.</SectionEmpty>
              ) : (
                <Table>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <Th fit>
                        <input
                          ref={all}
                          type="checkbox"
                          checked={allOn}
                          onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.number)))}
                          aria-label={allOn ? "Clear the selection" : `Select all ${rows.length} shown tickets`}
                          className="h-4 w-4 accent-compass-600"
                        />
                      </Th>
                      <Th>Ticket</Th>
                      <Th className="hidden md:table-cell">Team</Th>
                      <Th className="hidden md:table-cell">Deleted by</Th>
                      <Th className="hidden sm:table-cell">Deleted</Th>
                      <Th fit>
                        <span className="sm:hidden">Left</span>
                        <span className="hidden sm:inline">Deleted for good in</span>
                      </Th>
                      {/* Under sm a row's Restore is the ticket's own banner (the link) or the bulk Restore. */}
                      <Th fit className="hidden sm:table-cell">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const on = picked.has(r.number);
                      return (
                        <tr key={r.number} className={`${TR} ${on ? "bg-compass-50/60" : ""}`}>
                          <Td fit>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(r.number)}
                              aria-label={`Select #${r.number} ${r.subject}`}
                              className="h-4 w-4 accent-compass-600"
                            />
                          </Td>
                          <Td className="min-w-0">
                            <Link href={`/desk/recycle-bin/${r.number}`} className="font-medium text-slate-800 hover:underline">
                              <span className="font-semibold tabular-nums">#{r.number}</span> {r.subject}
                            </Link>
                            <span className="block text-xs text-slate-500 md:hidden">
                              {[r.team_name, `Deleted by ${r.deleted_by_name}`].filter(Boolean).join(" · ")}
                              <span className="sm:hidden"> · {binWhenLabel(r.deleted_at)}</span>
                            </span>
                          </Td>
                          <Td className="hidden md:table-cell">{r.team_name ?? "–"}</Td>
                          <Td className="hidden md:table-cell">{r.deleted_by_name}</Td>
                          <Td className="hidden whitespace-nowrap sm:table-cell">{binWhenLabel(r.deleted_at)}</Td>
                          <Td fit>
                            {r.legal_hold ? (
                              <span className="text-slate-600" data-tt="A legal hold was placed after it was deleted: it stays until the hold is lifted.">
                                On hold
                              </span>
                            ) : (
                              <span className={r.days_left <= 3 ? "font-medium ink-warn" : ""}>{binDaysLeftLabel(r.days_left)}</span>
                            )}
                          </Td>
                          <Td fit align="right" className="hidden sm:table-cell">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<Undo2 />}
                              busy={busy === `r${r.number}`}
                              disabled={!!busy}
                              onClick={() => void restore([r.number])}
                              aria-label={`Restore #${r.number}`}
                            >
                              Restore
                            </Button>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              You see deleted tickets from the teams you may delete in. Tickets on legal hold can&apos;t be deleted.
              {list.total > rows.length && ` Showing the newest ${rows.length} of ${list.total}.`}
            </p>
          </>
        )
      )}
    </PageContainer>
  );
}
