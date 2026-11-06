"use client";

// The Holidays page's two dialogs (agent L): add or edit one holiday (date,
// name, whole day or part of it, repeats every year), and paste a list
// ("2026-12-25 Christmas Day" per line), checked as you type.

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, TextInput, Textarea, Toggle } from "@/components/form";
import { Modal } from "@/components/Modal";
import { parseHolidayLines, validateHoliday } from "@/lib/helpdesk/calendars-shared";
import type { HdHoliday, HdHolidayInput } from "@/lib/helpdesk/calendars-shared";

function DialogHead({ id, title, sub, onClose }: { id: string; title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        {sub && <p className="mt-1 text-sm text-slate-600">{sub}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
        <X aria-hidden />
      </button>
    </div>
  );
}

export function HolidayDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: HdHoliday | { date: string } | null;
  onClose: () => void;
  onSave: (h: HdHolidayInput) => Promise<boolean>;
}) {
  const id = useId();
  const editing = initial && "id" in initial;
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState("13:00");
  const [to, setTo] = useState("00:00");
  const [yearly, setYearly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = initial && "id" in initial ? initial : null;
    setDate(initial?.date ?? "");
    setName(h?.name ?? "");
    setWhole(!h || (!h.closed_from && !h.closed_to));
    setFrom(h?.closed_from ?? "13:00");
    setTo(h?.closed_to ?? "00:00");
    setYearly(h?.recurring_yearly ?? false);
    setTried(false);
  }, [open, initial]);

  const input = { date, name, recurring_yearly: yearly, closed_from: whole ? null : from, closed_to: whole ? null : to === "00:00" ? null : to };
  const v = validateHoliday(input);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!v.ok) return;
    setBusy(true);
    const ok = await onSave(v.value);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy={id} className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <DialogHead id={id} title={editing ? "Edit holiday" : "Add a holiday"} onClose={onClose} />
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field label="Date" error={tried && !/^\d{4}-\d{2}-\d{2}$/.test(date) ? "Pick a date." : undefined}>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} data-autofocus="" />
            </Field>
            <Field label="Name" error={tried && !name.trim() ? "Name the holiday." : undefined}>
              <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Christmas Day" />
            </Field>
          </div>
          <Toggle label="Closed all day" help="Turn off to close part of the day, like a Christmas Eve afternoon." checked={whole} onChange={setWhole} size="full" />
          {!whole && (
            <div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Closed from" size="xs">
                  <TextInput type="time" value={from} onChange={(e) => setFrom(e.target.value || "00:00")} />
                </Field>
                <Field label="Until" size="xs">
                  <TextInput type="time" value={to} onChange={(e) => setTo(e.target.value || "00:00")} />
                </Field>
              </div>
              <p className="mt-1 text-xs text-slate-500">Until 00:00 means to the end of the day.</p>
            </div>
          )}
          <Toggle label="Repeats every year" help="Same day and month each year, like 25 December. Moving holidays (Easter) are added per year." checked={yearly} onChange={setYearly} size="full" />
          {tried && !v.ok && <p className="text-xs text-red-600" role="alert">{v.error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {editing ? "Save holiday" : "Add holiday"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function PasteDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (text: string) => Promise<boolean> }) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const parsed = parseHolidayLines(text);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed.holidays.length) return;
    setBusy(true);
    const ok = await onSave(text);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy={id} className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <DialogHead id={id} title="Paste a list of holidays" sub="One per line: the date, then the name. Add a time range for part of a day, or (yearly) at the end." onClose={onClose} />
        <Field label="Holidays" help={text.trim() ? `${parsed.holidays.length} holiday${parsed.holidays.length === 1 ? "" : "s"} found${parsed.errors.length ? `, ${parsed.errors.length} line${parsed.errors.length === 1 ? "" : "s"} skipped` : ""}.` : undefined}>
          <Textarea
            rows={8}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"2026-12-25 Christmas Day (yearly)\n2026-12-28 Boxing Day (substitute day)\n2026-12-24 13:00-24:00 Christmas Eve afternoon"}
            data-autofocus=""
          />
        </Field>
        {parsed.errors.length > 0 && (
          <ul className="mt-2 max-h-24 overflow-y-auto text-xs text-red-600">
            {parsed.errors.slice(0, 6).map((er) => (
              <li key={er.line}>
                Line {er.line}: {er.error}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!parsed.holidays.length}>
            {parsed.holidays.length ? `Add ${parsed.holidays.length} holiday${parsed.holidays.length === 1 ? "" : "s"}` : "Add holidays"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
