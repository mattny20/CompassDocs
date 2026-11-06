"use client";

// Settings → Calendars → Holidays (agent L): holiday sets on the left (the
// two-pane recipe), the selected set on the right as a year at a time:
// date, name, whole or part of the day, repeats yearly; Add holiday, Paste
// a list, Import .ics (read from the file only, never a URL), Copy to the
// next year for the one-off ones. Every change saves at once, toasts, and
// re-times the open tickets of the calendars that observe the set.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ClipboardPaste, CopyPlus, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { CardTitle } from "@/components/Heading";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { EmptyState, Select, SectionEmpty } from "@/components/form";
import { railIconClass, railRowClass } from "@/components/RailLink";
import { LoadingRow } from "@/components/Spinner";
import { Table, Td, Th } from "@/components/Table";
import { toast } from "@/components/Toasts";
import { DAY_SHORT } from "@/lib/helpdesk/calendars-shared";
import type { HdHoliday, HdHolidayInput, HdHolidaySet } from "@/lib/helpdesk/calendars-shared";
import { getJson, sendJson } from "../api";
import { HolidayDialog, PasteDialog } from "./HolidayDialogs";
import { useCalendarsData } from "./data";

type SetDetail = HdHolidaySet & { holidays: HdHoliday[] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${DAY_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

function closedLabel(h: HdHoliday): string {
  if (!h.closed_from && !h.closed_to) return "All day";
  if (h.closed_from && !h.closed_to) return `From ${h.closed_from}`;
  if (!h.closed_from && h.closed_to) return `Until ${h.closed_to}`;
  return `${h.closed_from}–${h.closed_to}`;
}

const retimedNote = (n: number) => (n ? ` ${n} open ticket${n === 1 ? "" : "s"} re-timed.` : "");

export function HolidaysPanel() {
  const { data, error, reload } = useCalendarsData();
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [editing, setEditing] = useState<HdHoliday | { date: string } | null>(null);
  const [pasting, setPasting] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    if (selected == null || !data.holiday_sets.some((s) => s.id === selected)) setSelected(data.holiday_sets[0]?.id ?? null);
  }, [data, selected]);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const d = await getJson<{ holiday_set: SetDetail }>(`/api/helpdesk/admin/holiday-sets/${id}`, "Couldn't load the holidays.");
      setDetail(d.holiday_set);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (selected != null) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const refresh = async () => {
    await reload();
    if (selected != null) await loadDetail(selected);
  };

  const years = useMemo(() => {
    const ys = new Set<number>([thisYear, thisYear + 1]);
    for (const h of detail?.holidays ?? []) if (!h.recurring_yearly) ys.add(Number(h.date.slice(0, 4)));
    return [...ys].sort((a, b) => a - b);
  }, [detail, thisYear]);

  const rows = useMemo(() => {
    const out: (HdHoliday & { shown: string })[] = [];
    for (const h of detail?.holidays ?? []) {
      if (h.recurring_yearly) {
        const shown = `${year}${h.date.slice(4)}`;
        if (h.date.slice(5) === "02-29" && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) continue;
        out.push({ ...h, shown });
      } else if (h.date.startsWith(`${year}-`)) out.push({ ...h, shown: h.date });
    }
    return out.sort((a, b) => a.shown.localeCompare(b.shown) || a.name.localeCompare(b.name));
  }, [detail, year]);
  const oneOffs = rows.filter((r) => !r.recurring_yearly).length;

  if (error && !data) return <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>;
  if (!data) return <LoadingRow className="py-10" />;

  const usedBy = (s: HdHolidaySet) => s.calendar_ids.map((id) => data.calendars.find((c) => c.id === id)?.name).filter(Boolean) as string[];

  async function createSet() {
    const v = await formDialog({
      title: "New holiday set",
      body: "A list of closures, like a country's bank holidays or an office's shutdown days. Attach it to calendars on the Office hours page.",
      fields: [
        { key: "name", label: "Name", placeholder: "UK bank holidays" },
        { key: "description", label: "Description (optional)", required: false, placeholder: "England and Wales" },
      ],
      confirmLabel: "Create set",
    });
    if (!v) return;
    try {
      const r = await sendJson<{ holiday_set: SetDetail }>("/api/helpdesk/admin/holiday-sets", "POST", { name: v.name.trim(), description: v.description.trim() }, "Couldn't create the holiday set.");
      toast("ok", `${r.holiday_set.name} created.`);
      await reload();
      setSelected(r.holiday_set.id);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function renameSet() {
    if (!detail) return;
    const v = await formDialog({
      title: "Rename holiday set",
      fields: [
        { key: "name", label: "Name", initial: detail.name },
        { key: "description", label: "Description (optional)", required: false, initial: detail.description },
      ],
      confirmLabel: "Save",
    });
    if (!v) return;
    try {
      await sendJson(`/api/helpdesk/admin/holiday-sets/${detail.id}`, "PATCH", { name: v.name.trim(), description: v.description.trim() }, "Couldn't rename the set.");
      toast("ok", "Holiday set saved.");
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function deleteSet() {
    if (!detail) return;
    const cals = usedBy(detail);
    const ok = await confirmDialog({
      title: `Delete ${detail.name}?`,
      body: `Its ${detail.holidays.length} holiday${detail.holidays.length === 1 ? "" : "s"} go with it.${cals.length ? ` ${cals.join(", ")} will no longer close on them.` : ""}`,
      confirmLabel: "Delete set",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJson<{ retimed: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}`, "DELETE", undefined, "Couldn't delete the set.");
      toast("ok", `${detail.name} deleted.${retimedNote(r.retimed)}`);
      setSelected(null);
      await reload();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function saveHoliday(h: HdHolidayInput): Promise<boolean> {
    if (!detail) return false;
    const existing = editing && "id" in editing ? editing : null;
    try {
      const r = existing
        ? await sendJson<{ retimed: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}/holidays/${existing.id}`, "PATCH", h, "Couldn't save the holiday.")
        : await sendJson<{ retimed: number; duplicates: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}/holidays`, "POST", { holidays: [h] }, "Couldn't add the holiday.");
      if ("duplicates" in r && r.duplicates) toast("ok", `${h.name} is already in this set.`);
      else toast("ok", `${h.name} ${existing ? "saved" : "added"}.${retimedNote(r.retimed)}`);
      setYear(Number(h.date.slice(0, 4)) || year);
      await refresh();
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    }
  }

  async function savePaste(text: string): Promise<boolean> {
    if (!detail) return false;
    try {
      const r = await sendJson<{ added: HdHoliday[]; duplicates: number; retimed: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}/holidays`, "POST", { text }, "Couldn't add the holidays.");
      toast("ok", `${r.added.length} holiday${r.added.length === 1 ? "" : "s"} added${r.duplicates ? `, ${r.duplicates} already there` : ""}.${retimedNote(r.retimed)}`);
      await refresh();
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    }
  }

  async function importIcs(f: File) {
    if (!detail) return;
    const form = new FormData();
    form.set("file", f, f.name);
    try {
      const res = await fetch(`/api/helpdesk/admin/holiday-sets/${detail.id}/import`, { method: "POST", body: form, headers: { accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't import that file.");
      toast("ok", `${body.added.length} holiday${body.added.length === 1 ? "" : "s"} imported from ${f.name}${body.duplicates ? `, ${body.duplicates} already there` : ""}${body.skipped?.length ? `, ${body.skipped.length} skipped` : ""}.${retimedNote(body.retimed)}`);
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      if (file.current) file.current.value = "";
    }
  }

  async function copyYear() {
    if (!detail) return;
    try {
      const r = await sendJson<{ added: HdHoliday[]; duplicates: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}/copy-year`, "POST", { from_year: year, to_year: year + 1 }, "Couldn't copy the holidays.");
      toast("ok", r.added.length ? `${r.added.length} holiday${r.added.length === 1 ? "" : "s"} copied to ${year + 1}. Check the dates of holidays that move.` : `Everything in ${year} is already in ${year + 1}.`);
      setYear(year + 1);
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function removeHoliday(h: HdHoliday) {
    if (!detail) return;
    const ok = await confirmDialog({ title: `Remove ${h.name}?`, body: h.recurring_yearly ? "It repeats every year: this removes every year's." : undefined, confirmLabel: "Remove", danger: true });
    if (!ok) return;
    try {
      const r = await sendJson<{ retimed: number }>(`/api/helpdesk/admin/holiday-sets/${detail.id}/holidays/${h.id}`, "DELETE", undefined, "Couldn't remove the holiday.");
      toast("ok", `${h.name} removed.${retimedNote(r.retimed)}`);
      await refresh();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  if (!data.holiday_sets.length) {
    return <EmptyState icon={<CalendarDays />} title="No holiday sets yet" body="Add the days your teams are closed. Reply targets stop counting on them." action={{ label: "New holiday set", onClick: createSet }} />;
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card id="holiday-sets" padding="none" title="Holiday sets" className="scroll-mt-6 self-start lg:sticky lg:top-6">
        <ul role="list" className="space-y-0.5 p-2">
          {data.holiday_sets.map((s) => {
            const active = s.id === selected;
            const cals = usedBy(s);
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setSelected(s.id)} aria-current={active ? "true" : undefined} className={`w-full text-left ${railRowClass(active, { dense: true })}`}>
                  <CalendarDays className={`mt-0.5 h-4 w-4 self-start ${railIconClass(active)}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.name}</span>
                    <span className="block truncate text-2xs font-normal text-slate-500">
                      <span className="sr-only">, </span>
                      {s.holiday_count} holiday{s.holiday_count === 1 ? "" : "s"} · {cals.length ? cals.join(", ") : "Not on a calendar"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-slate-100 px-4 py-3">
          <Button variant="secondary" icon={<Plus />} onClick={createSet}>
            New holiday set
          </Button>
        </div>
      </Card>

      {detail && (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>{detail.name}</CardTitle>
              <p className="text-sm text-slate-500">
                {usedBy(detail).length ? `Observed by ${usedBy(detail).join(", ")}` : "Not attached to a calendar yet: attach it on the Office hours page."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<Pencil />} onClick={renameSet}>
                Rename
              </Button>
              <Button variant="danger" size="sm" icon={<Trash2 />} onClick={deleteSet}>
                Delete
              </Button>
            </div>
          </div>

          <Card padding="none" id="holidays-year" className="scroll-mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <label htmlFor="hd-holiday-year" className="text-sm font-medium text-slate-800">
                  Year
                </label>
                <Select id="hd-holiday-year" dense className="w-auto" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<Plus />} onClick={() => setEditing({ date: `${year}-01-01` })}>
                  Add holiday
                </Button>
                <Button variant="secondary" size="sm" icon={<ClipboardPaste />} onClick={() => setPasting(true)}>
                  Paste a list
                </Button>
                <Button variant="secondary" size="sm" icon={<FileUp />} onClick={() => file.current?.click()}>
                  Import .ics
                </Button>
                <input
                  ref={file}
                  type="file"
                  accept=".ics,text/calendar"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importIcs(f);
                  }}
                />
                {oneOffs > 0 && (
                  <Button variant="secondary" size="sm" icon={<CopyPlus />} onClick={copyYear}>
                    Copy to {year + 1}
                  </Button>
                )}
              </div>
            </div>
            {rows.length === 0 ? (
              <SectionEmpty className="px-4 py-6" action={{ label: "Add a holiday", onClick: () => setEditing({ date: `${year}-01-01` }) }}>
                No holidays in {year}.
              </SectionEmpty>
            ) : (
              <Table scroll minWidth="34rem">
                <thead>
                  <tr>
                    <Th fit>Date</Th>
                    <Th>Holiday</Th>
                    <Th fit>Closed</Th>
                    {/* relative: the sr-only label is absolutely positioned and would escape the scroller at phone width. */}
                    <Th fit className="relative">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => (
                    <tr key={`${h.id}-${h.shown}`} className="border-b border-slate-100 last:border-b-0">
                      <Td fit className="tabular-nums text-slate-700">
                        <time dateTime={h.shown}>{dayLabel(h.shown)}</time>
                      </Td>
                      <Td>
                        <span className="font-medium text-slate-800">{h.name}</span>
                        {h.recurring_yearly && <span className={`${chipClass("accent", "sm")} ml-2`}>Every year</span>}
                      </Td>
                      <Td fit className="text-slate-600">
                        {closedLabel(h)}
                      </Td>
                      <Td fit>
                        <div className="flex justify-end gap-0.5">
                          <button type="button" className={iconButtonClass("quiet", "sm")} aria-label={`Edit ${h.name}`} data-tt="Edit" onClick={() => setEditing(h)}>
                            <Pencil aria-hidden />
                          </button>
                          <button type="button" className={iconButtonClass("quiet", "sm")} aria-label={`Remove ${h.name}`} data-tt="Remove" onClick={() => void removeHoliday(h)}>
                            <Trash2 aria-hidden />
                          </button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <p className="text-xs text-slate-500">
            .ics files are read from your computer only (all-day events, and yearly repeats). Holidays that move each year, like Easter, are added year by year: use Copy to {year + 1} and fix their dates.
          </p>
        </div>
      )}
      <HolidayDialog open={editing !== null} initial={editing} onClose={() => setEditing(null)} onSave={saveHoliday} />
      <PasteDialog open={pasting} onClose={() => setPasting(false)} onSave={savePaste} />
    </div>
  );
}
